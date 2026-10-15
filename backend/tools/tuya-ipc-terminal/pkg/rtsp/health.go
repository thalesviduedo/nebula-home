package rtsp

/**
 * Diagnóstico da ponte.
 *
 * O sintoma que motivou isto: o processo vivia, o stream RTSP era registrado,
 * e o leitor Python recebia zero bytes — `InvalidDataError` para sempre, sem
 * nenhuma pista de POR QUÊ. Três causas distintas produziam exatamente o mesmo
 * silêncio:
 *
 *   1. sessão sem `mobileMqttsUrl` (login por QR) -> `dial tcp :443`;
 *   2. sessão expirada na nuvem -> `USER_SESSION_INVALID`;
 *   3. WebRTC conecta mas a câmera não manda RTP -> stream "seco".
 *
 * Aqui elas viramcategorias fechadas (`ErrKind`) e viram estado observável
 * (`CameraHealth`), para o backend Python poder agir em vez de repetir.
 */

import (
	"errors"
	"fmt"
	"strings"
)

type ErrKind string

const (
	KindUnknown ErrKind = ""
	// Sessão não tem o que a câmera precisa: sem accessToken/ecode não há
	// MQTT, sem mobileMqttsUrl não há broker. Recuperação: refazer login por
	// e-mail e senha.
	KindSessionIncomplete ErrKind = "session_incomplete"
	// A nuvem rejeitou a sessão (USER_SESSION_INVALID e afins). Recuperação:
	// refazer login.
	KindSessionInvalid ErrKind = "session_invalid"
	// MQTT não conectou (broker fechado, TLS, DNS). Recuperação: repetir; se
	// persistir com sessão válida, é rede/broker.
	KindMQTT ErrKind = "mqtt"
	// WebRTC/OFFER/answer falhou. Recuperação: repetir; se persistir, câmera
	// ocupada por outro cliente ou sem permissão de compartilhamento.
	KindWebRTC ErrKind = "webrtc"
	// Nenhuma config da câmera (GetWebRTCConfig / skill).
	KindConfig ErrKind = "config"
	// Rede da máquina.
	KindNetwork ErrKind = "network"
)

type BridgeError struct {
	Kind ErrKind
	Err  error
	// Advice is shown verbatim in the dashboard; keep it human.
	Advice string
}

func (e *BridgeError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %v", e.Kind, e.Err)
}

func (e *BridgeError) Unwrap() error { return e.Err }

// Advice returns what the user should do, in Portuguese.
func (e *BridgeError) AdviceText() string {
	if e == nil {
		return ""
	}
	if e.Advice != "" {
		return e.Advice
	}
	return adviceFor(e.Kind)
}

func adviceFor(k ErrKind) string {
	switch k {
	case KindSessionIncomplete:
		return "sessão parcial: refaça o login com e-mail e senha (o login por QR não traz accessToken, e sem ele a câmera não tem MQTT)"
	case KindSessionInvalid:
		return "sessão expirada na nuvem: refaça o login com e-mail e senha"
	case KindMQTT:
		return "não foi possível falar com o broker MQTT da Tuya; se a sessão é boa, é rede/VPN bloqueando wss://m1.tuyaus.com"
	case KindWebRTC:
		return "a oferta WebRTC não foi aceita; a câmera pode estar ocupada por outro cliente (o app aberto) ou sem permissão de compartilhamento"
	case KindConfig:
		return "a nuvem não devolveu a configuração de vídeo desta câmera"
	case KindNetwork:
		return "falha de rede ao falar com a nuvem"
	}
	return "falha desconhecida na ponte de vídeo"
}

const sessionInvalidMarkers = "USER_SESSION_INVALID,USER_SESSION_EXPIRED,TOKEN_INVALID,TOKEN_EXPIRED,SID_INVALID,USER_NOT_EXIST,VERIFY_CODE_EXPIRE"

func classify(err error, stage string) ErrKind {
	if err == nil {
		return KindUnknown
	}
	up := strings.ToUpper(err.Error())
	for _, marker := range strings.Split(sessionInvalidMarkers, ",") {
		if strings.Contains(up, marker) {
			return KindSessionInvalid
		}
	}
	switch stage {
	case "appinfo", "mqttconfig":
		return KindSessionInvalid
	case "mqtt":
		return KindMQTT
	case "config":
		return KindConfig
	case "webrtc":
		return KindWebRTC
	}
	if strings.Contains(up, "NO SUCH HOST") || strings.Contains(up, "CONNECTION REFUSED") ||
		strings.Contains(up, "TIMEOUT") || strings.Contains(up, "EOF") ||
		strings.Contains(up, "TLS") || strings.Contains(up, "CERTIFICATE") {
		return KindNetwork
	}
	return KindUnknown
}

func wrapErr(kind ErrKind, stage string, err error) error {
	if err == nil {
		return nil
	}
	if k := classify(err, stage); k != KindUnknown && kind == KindUnknown {
		kind = k
	}
	return &BridgeError{Kind: kind, Err: fmt.Errorf("%s: %w", stage, err)}
}

// ClassifyKind is the exported entry point used by `serve` to label a fatal
// error before the process exits.
func ClassifyKind(err error, stage string) string {
	k := classify(err, stage)
	if k == KindUnknown {
		return "unknown"
	}
	return string(k)
}

// AdviceFor returns the user-facing instruction for an error.
func AdviceFor(err error) string {
	var be *BridgeError
	if errors.As(err, &be) {
		return be.AdviceText()
	}
	return adviceFor(classify(err, "unknown"))
}

// ErrEmptyMQTTHost is what the old code silently turned into `dial tcp :443:
// connect: connection refused`. It is the single most common cause of a
// stream that exists and never carries media.
var ErrEmptyMQTTHost = errors.New("mobileMqttsUrl vazio: a sessao do bundle nao traz o broker MQTT (login por QR nao devolve accessToken)")

// CameraHealth is one camera's ground truth, as of a point in time.
type CameraHealth struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	DeviceID string `json:"deviceId"`

	Registered bool `json:"registered"`
	Connecting bool `json:"connecting"`
	Connected  bool `json:"connected"` // WebRTC bridge reports itself up
	Active     bool `json:"active"`    // stream object is live
	Clients    int  `json:"clients"`

	// state is one of: idle | connecting | live | stalled | failed
	State string `json:"state"`

	Media MediaStats `json:"media"`

	// Age of the connection attempt / of the stream object.
	ConnectingFor float64 `json:"connectingForSec"`
	ActiveFor     float64 `json:"activeForSec"`

	LastError   string  `json:"lastError,omitempty"`
	LastErrorAt float64 `json:"lastErrorAgeSec,omitempty"`
	ErrorKind   string  `json:"errorKind,omitempty"`

	Restarts int `json:"teardowns"`
}

// Streaming reports whether real media is currently flowing.
func (h CameraHealth) Streaming() bool {
	return h.State == "live"
}
