package cmd

/**
 * Endpoint de saúde da ponte de vídeo.
 *
 * Por que existe: o sintoma era "processo vivo, stream registrado, zero bytes".
 * A única informação que o backend tinha era o log, e o log não distingue
 * "conectando" de "transmitindo". Este servidor responde três perguntas
 * objetivas — a câmera tem media fluindo? desde quando? qual foi o último erro
 * e de que categoria? — e permite reiniciar UMA câmera sem matar o processo.
 *
 *   GET  /media                  snapshot de todas as câmeras
 *   GET  /session                estado da sessão + último erro fatal
 *   POST /restart?path=<p>       derruba o stream (rebuild no próximo reader)
 *   POST /restart?deviceId=<id>  idem
 *   GET  /healthz                vivo?
 *
 * Sem este canal o backend teria que inferir tudo de texto de log, que é
 * exatamente o que falhou antes.
 */

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"tuya-ipc-terminal/pkg/core"
	"tuya-ipc-terminal/pkg/rtsp"
)

func startHealthServer(addr string, srv *rtsp.RTSPServer, ready func() bool) *http.Server {
	mux := http.NewServeMux()

	writeJSON := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}

	mux.HandleFunc("/media", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, srv.Health())
	})

	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		h := srv.Health()
		writeJSON(w, 200, map[string]any{
			"running":            h.Running,
			"lastError":          h.LastError,
			"lastErrorKind":      h.LastErrKind,
			"lastErrorAgeSec":    h.LastErrAge,
			"connectTimeoutSec":  h.ConnectTO,
			"stallTimeoutSec":    h.StallTO,
			"camerasDiscovered":  len(h.Cameras),
			"camerasStreaming":   countStreaming(h),
			"ts":                 time.Now().UTC().Format(time.RFC3339Nano),
		})
	})

	mux.HandleFunc("/restart", func(w http.ResponseWriter, r *http.Request) {
		target := r.URL.Query().Get("path")
		if target == "" {
			target = r.URL.Query().Get("deviceId")
		}
		if target == "" {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "informe ?path= ou ?deviceId="})
			return
		}
		hit := srv.RestartCamera(target)
		core.Logger.Warn().Msgf("restart pedido via API para %s (encontrado=%v)", target, hit)
		writeJSON(w, 200, map[string]any{"ok": true, "target": target, "found": hit})
	})

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		ok := ready == nil || ready()
		writeJSON(w, map[bool]int{true: 200, false: 503}[ok],
			map[string]any{"ok": ok, "ts": time.Now().UTC().Format(time.RFC3339Nano)})
	})

	srvHTTP := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := srvHTTP.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			core.Logger.Warn().Err(err).Msgf("endpoint de saude indisponivel em %s", addr)
		} else {
			core.Logger.Info().Msgf("endpoint de saude em http://%s/media", addr)
		}
	}()
	return srvHTTP
}

func countStreaming(h rtsp.CamerasHealth) int {
	n := 0
	for _, c := range h.Cameras {
		if c.Streaming() {
			n++
		}
	}
	return n
}

// fatal prints a machine-readable reason before the process dies. The backend
// maps `reason` to a human instruction instead of showing "processo do RTSP
// saiu".
func fatal(reason string, err error) {
	fmt.Printf("NEBULA_FATAL reason=%s detail=%s\n", reason, sanitizeLogField(err.Error()))
	os.Stdout.Sync()
	core.Logger.Error().Msgf("abortando: %s", err)
}

func sanitizeLogField(v string) string {
	out := make([]rune, 0, len(v))
	for _, r := range v {
		if r == '\n' || r == '\r' || r == '\t' {
			r = ' '
		}
		out = append(out, r)
	}
	s := string(out)
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}