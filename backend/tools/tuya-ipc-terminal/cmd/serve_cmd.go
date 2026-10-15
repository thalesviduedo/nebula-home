package cmd

/**
 * `serve` — sobe o RTSP sem gravar nada em disco.
 *
 * O `rtsp start` original lê a sessão de `./.tuya-data`. Aqui a sessão chega
 * por variável de ambiente (base64url do mesmo bundle que o navegador manda
 * ao backend), vira um UserSession em RAM, as câmeras são descobertas e o
 * servidor RTSP sobe. Nenhum arquivo é criado ou lido.
 *
 *   NEBULA_BUNDLE=<base64>  ./tuya-ipc-terminal serve --port 8554
 *
 * O bundle só precisa do bloco `cloud`: host, região e cookies.
 */

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/net/publicsuffix"
	"tuya-ipc-terminal/pkg/core"
	"tuya-ipc-terminal/pkg/rtsp"
	"tuya-ipc-terminal/pkg/storage"
	"tuya-ipc-terminal/pkg/tuya"
)

type wireCloud struct {
	Host    string `json:"host"`
	Region  string `json:"region"`
	UID     string `json:"uid"`
	Email   string `json:"email"`
	// MQTT do app mobile (m1.tuyaus.com). O login web não devolve `domain`,
	// então o backend preenche; vazio = comportamento antigo.
	MobileMqttsUrl string `json:"mobileMqttsUrl"`
	Cookies []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"cookies"`
}

type wireBundle struct {
	Cloud *wireCloud `json:"cloud"`
}

func sessionFromEnv() (*storage.UserSession, error) {
	raw := strings.TrimSpace(os.Getenv("NEBULA_BUNDLE"))
	if raw == "" {
		return nil, fmt.Errorf("NEBULA_BUNDLE vazio")
	}
	if len(raw)%4 != 0 {
		raw += strings.Repeat("=", 4-len(raw)%4)
	}
	blob, err := base64.URLEncoding.DecodeString(raw)
	if err != nil {
		raw2 := strings.NewReplacer("-", "+", "_", "/").Replace(raw)
		if b2, e2 := base64.StdEncoding.DecodeString(raw2); e2 == nil {
			blob, err = b2, nil
		}
		if err != nil {
			return nil, fmt.Errorf("bundle nao decodificou: %w", err)
		}
	}
	var wb wireBundle
	if err := json.Unmarshal(blob, &wb); err != nil {
		return nil, fmt.Errorf("bundle invalido: %w", err)
	}
	if wb.Cloud == nil || wb.Cloud.Host == "" || len(wb.Cloud.Cookies) == 0 {
		return nil, fmt.Errorf("bundle sem bloco cloud")
	}

	cookies := make([]*tuya.Cookie, 0, len(wb.Cloud.Cookies))
	for _, c := range wb.Cloud.Cookies {
		cookies = append(cookies, &tuya.Cookie{
			Name:   c.Name,
			Value:  c.Value,
			Domain: wb.Cloud.Host,
			Path:   "/",
			Secure: true,
		})
	}

	region := wb.Cloud.Region
	if region == "" {
		region = "us-west"
	}
	safeEmail := strings.NewReplacer("@", "_at_", ".", "_").Replace(wb.Cloud.Email)
	if wb.Cloud.Email == "" {
		safeEmail = "conta"
	}

	return &storage.UserSession{
		Region:    region,
		Email:     wb.Cloud.Email,
		UserKey:   fmt.Sprintf("%s_%s", region, safeEmail),
		LastRefresh: time.Now(),
		SessionData: &tuya.SessionData{
			LoginResult: &tuya.LoginResult{
				Uid:   wb.Cloud.UID,
				Email: wb.Cloud.Email,
				Sid:   wb.Cloud.UID,
				Domain: tuya.Domain{
					MobileMqttsUrl: wb.Cloud.MobileMqttsUrl,
				},
			},
			Cookies:       cookies,
			LastValidated: time.Now(),
			ServerHost:    wb.Cloud.Host,
			Region:        region,
			UserEmail:     wb.Cloud.Email,
		},
	}, nil
}

func newServeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Sobe o RTSP a partir da sessao do bundle, sem tocar em disco",
		RunE:  runServe,
	}
	cmd.Flags().Int("port", 8554, "porta do RTSP")
	cmd.Flags().Int("health-port", -1, "porta HTTP de saude (-1 = porta do RTSP + 1, 0 = desliga)")
	cmd.Flags().Duration("connect-timeout", 25*time.Second, "handshake WebRTC/MQTT sem media apos isso conta como camera morta")
	cmd.Flags().Duration("stall-timeout", 12*time.Second, "silencio de video apos isso conta como camera morta")
	return cmd
}

// drainRest consome o resto da saída para o pipe não travar.
func drainRest(r interface{ Read([]byte) (int, error) }) {
	if r == nil {
		return
	}
	buf := make([]byte, 4096)
	for {
		if _, err := r.Read(buf); err != nil {
			return
		}
	}
}

func runServe(cmd *cobra.Command, args []string) error {
	port, _ := cmd.Flags().GetInt("port")
	connectTimeout, _ := cmd.Flags().GetDuration("connect-timeout")
	stallTimeout, _ := cmd.Flags().GetDuration("stall-timeout")
	procOut := os.Stdout

	user, err := sessionFromEnv()
	if err != nil {
		fatal("bundle_invalido", err)
		return err
	}

	// Fail fast BEFORE opening any port. A session without a broker address
	// can never carry media; starting anyway produced a registered RTSP path
	// that delivered nothing, forever.
	if ok, why := validateSessionForBridge(user); !ok {
		wrapped := fmt.Errorf("sessao incompleta (%s): refaca o login com e-mail e senha", why)
		fatal("session_incomplete", wrapped)
		return wrapped
	}
	core.Logger.Info().Msgf("sessao do bundle: %s @ %s (broker %s)", user.Email,
		user.SessionData.ServerHost, user.SessionData.LoginResult.Domain.MobileMqttsUrl)

	// valida a sessão antes de gastar tempo com discovery
	client := createHTTPClientWithSession(user.SessionData)
	if _, err := tuya.GetAppInfo(client, user.SessionData.ServerHost); err != nil {
		wrapped := fmt.Errorf("sessao invalida: %w", err)
		fatal(rtsp.ClassifyKind(err, "appinfo"), wrapped)
		return wrapped
	}
	core.Logger.Info().Msg("sessao valida")

	mgr := storage.NewMemoryManager()
	if err := mgr.SaveUser(user.Region, user.Email, user.SessionData); err != nil {
		return err
	}

	cams, err := discoverCamerasForUser(user)
	if err != nil {
		core.Logger.Warn().Msgf("discovery falhou: %v", err)
	}
	if len(cams) == 0 {
		core.Logger.Warn().Msg("nenhuma camera encontrada na conta")
	} else {
		if err := mgr.UpdateCamerasForUser(user.UserKey, cams); err != nil {
			return err
		}
		for _, c := range cams {
			core.Logger.Info().Msgf("camera: %s -> rtsp://127.0.0.1:%d%s",
				c.DeviceName, port, c.RTSPPath)
		}
	}

	srv := rtsp.NewRTSPServer(port, mgr)
	srv.SetWatchdog(connectTimeout, stallTimeout)
	if err := srv.Start(); err != nil {
		fatal("porta_ocupada", err)
		return err
	}
	core.Logger.Info().Msgf("RTSP no ar em 127.0.0.1:%d (%d camera(s))", port, len(cams))

	// Canal de saúde: é o que permite ao backend distinguir "conectando" de
	// "transmitindo" e reiniciar uma câmera sem derrubar o processo.
	ready := false
	healthPort, _ := cmd.Flags().GetInt("health-port")
	if healthPort < 0 {
		healthPort = port + 1
	}
	if healthPort > 0 {
		startHealthServer(fmt.Sprintf("127.0.0.1:%d", healthPort), srv, func() bool { return ready })
	}

	// uma linha legível por máquina: o backend lê e popula a lista de fontes
	payload, _ := json.Marshal(cams)
	fmt.Printf("NEBULA_RTSP_SOURCES %s\n", payload)
	fmt.Printf("NEBULA_RTSP_READY port=%d health=%d cameras=%d\n", port, healthPort, len(cams))
	os.Stdout.Sync()
	ready = true

	go drainRest(procOut)

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	core.Logger.Info().Msg("encerrando")
	return srv.Stop()
}

// validateSessionForBridge returns (ok, humanReason).
func validateSessionForBridge(user *storage.UserSession) (bool, string) {
	if user == nil || user.SessionData == nil || user.SessionData.LoginResult == nil {
		return false, "bundle sem sessao (faça login)"
	}
	if strings.TrimSpace(user.SessionData.LoginResult.Uid) == "" {
		return false, "sessao sem uid (login por QR nao devolve uid)"
	}
	if strings.TrimSpace(user.SessionData.LoginResult.Domain.MobileMqttsUrl) == "" {
		return false, "sessao sem mobileMqttsUrl (login por QR nao devolve accessToken)"
	}
	return true, ""
}

// --- infraestrutura mínima, espelhando cmd/auth e cmd/cameras ---------------

func createHTTPClientWithSession(sd *tuya.SessionData) *http.Client {
	jar, err := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	if err != nil {
		return nil
	}
	if sd != nil && len(sd.Cookies) > 0 {
		u, _ := url.Parse("https://" + sd.ServerHost)
		var hc []*http.Cookie
		for _, c := range sd.Cookies {
			hc = append(hc, &http.Cookie{
				Name: c.Name, Value: c.Value, Domain: c.Domain,
				Path: c.Path, Secure: c.Secure, HttpOnly: c.HttpOnly,
			})
		}
		jar.SetCookies(u, hc)
	}
	return &http.Client{Jar: jar, Timeout: 30 * time.Second}
}

func containsDevice(devices []tuya.Device, id string) bool {
	for _, d := range devices {
		if d.DeviceId == id {
			return true
		}
	}
	return false
}

// discoverCamerasForUser percorre as casas (e as compartilhadas) e monta a
// lista de câmeras com o caminho RTSP de cada uma.
func discoverCamerasForUser(user *storage.UserSession) ([]storage.CameraInfo, error) {
	if user.SessionData == nil {
		return nil, fmt.Errorf("bundle sem sessao")
	}
	host := user.SessionData.ServerHost
	client := createHTTPClientWithSession(user.SessionData)
	if client == nil {
		return nil, fmt.Errorf("http client")
	}
	if _, err := tuya.GetAppInfo(client, host); err != nil {
		return nil, fmt.Errorf("sessao invalida: %w", err)
	}

	var devices []tuya.Device
	seenAll := 0
	if homes, _ := tuya.GetHomeList(client, host); homes != nil {
		for _, home := range homes.Result {
			rooms, err := tuya.GetRoomList(client, host, strconv.Itoa(home.Gid))
			if err != nil {
				continue
			}
			for _, room := range rooms.Result {
				seenAll += len(room.DeviceList)
				for _, dev := range room.DeviceList {
					if isCamDevice(dev) && !containsDevice(devices, dev.DeviceId) {
						devices = append(devices, dev)
					}
				}
			}
		}
	}
	if shared, _ := tuya.GetSharedHomeList(client, host); shared != nil {
		for _, sh := range shared.Result.SecurityWebCShareInfoList {
			for _, dev := range sh.DeviceInfoList {
				if isCamDevice(dev) && !containsDevice(devices, dev.DeviceId) {
					devices = append(devices, dev)
				}
			}
		}
	}
	core.Logger.Info().Msgf("%d device(s) na conta, %d categoria de camera", seenAll, len(devices))
	if len(devices) == 0 {
		return nil, nil
	}

	names := storage.NewMemoryManager()
	var out []storage.CameraInfo
	for _, dev := range devices {
		cfg, err := tuya.GetWebRTCConfig(client, host, dev.DeviceId)
		if err != nil {
			continue
		}
		skill := ""
		if cfg != nil {
			skill = cfg.Result.Skill
		}
		out = append(out, storage.CameraInfo{
			UserKey:    user.UserKey,
			DeviceID:   dev.DeviceId,
			DeviceName: dev.DeviceName,
			Category:   dev.Category,
			RTSPPath:   names.GenerateRTSPPath(dev.DeviceName, dev.DeviceId),
			ProductID:  dev.ProductId,
			UUID:       dev.Uuid,
			Skill:      skill,
		})
	}
	return out, nil
}

// isCamCategory: o appTuya usa "sp" para IPC, mas a conta pode devolver
// "ipc" ou variantes de marca. P2pType (quando >0) também denuncia câmera.
func isCamCategory(cat string) bool {
	switch cat {
	case "sp", "dghsxj", "ipc", "ipc_", "camera", "snpai", "tycamera":
		return true
	}
	return false
}

func isCamDevice(d tuya.Device) bool {
	return isCamCategory(d.Category) || d.P2pType > 0
}