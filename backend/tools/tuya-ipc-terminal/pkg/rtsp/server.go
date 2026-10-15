package rtsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"tuya-ipc-terminal/pkg/core"
	"tuya-ipc-terminal/pkg/storage"
	"tuya-ipc-terminal/pkg/tuya"
)

type RTSPServer struct {
	port           int
	listener       net.Listener
	storageManager *storage.StorageManager
	clients        map[string]*RTSPClient
	streams        map[string]*CameraStream
	mutex          sync.RWMutex
	ctx            context.Context
	cancel         context.CancelFunc
	running        bool

	// Media watchdog policy (overridable from serve flags).
	connectTimeout time.Duration // how long "connecting" may stay connecting
	stallTimeout   time.Duration // how long media may stay silent

	// lastSessionError is the newest fatal session/config error seen; the
	// health endpoint republishes it so Python never has to parse logs.
	lastSessionError   string
	lastSessionErrKind string
	lastSessionErrAt   time.Time
}

type RTSPClient struct {
	conn                 net.Conn
	session              string
	cameraPath           string
	stream               *CameraStream
	reader               *bufio.Reader
	transportMode        TransportMode
	videoRTPPort         int
	videoRTCPPort        int
	audioRTPPort         int
	audioRTCPPort        int
	backAudioRTPPort     int // server-side port for back audio
	backAudioRTCPPort    int // server-side port for back audio RTCP
	videoRTPChannel      byte
	videoRTCPChannel     byte
	audioRTPChannel      byte
	audioRTCPChannel     byte
	backAudioRTPChannel  byte
	backAudioRTCPChannel byte
	setupCount           int
}

type CameraStream struct {
	camera       *storage.CameraInfo
	resolution   string
	user         *storage.UserSession
	webrtcBridge *WebRTCBridge
	clients      map[string]*RTSPClient
	mutex        sync.RWMutex
	connecting   bool
	active       bool
	lastActivity time.Time

	// connectingSince / activeSince are what turn "registered" into "we have
	// been waiting this long and still nothing".
	connectingSince time.Time
	activeSince     time.Time

	// starting marks that startStream() is running. It is NOT the same as
	// `connecting`, which is also set at reservation time by
	// getOrCreateStream; conflating the two meant AddClient saw
	// `connecting == true` and never kicked the bridge off.
	starting bool

	// stalledAt is set by the watchdog the first time media went silent; the
	// second consecutive hit tears the stream down.
	stalledAt time.Time
	restarts  int

	lastError   string
	lastErrKind ErrKind
	lastErrAt   time.Time

	// Delayed shutdown
	shutdownTimer *time.Timer
	shutdownDelay time.Duration

	// Reference to server for cleanup
	server   *RTSPServer
	streamId string
}

type ServerConfig struct {
	Port                 int
	MaxClients           int
	StreamTimeout        time.Duration
	ConnectionTimeout    time.Duration
	EnableAuthentication bool
}

func NewRTSPServer(port int, storageManager *storage.StorageManager) *RTSPServer {
	ctx, cancel := context.WithCancel(context.Background())

	return &RTSPServer{
		port:           port,
		storageManager: storageManager,
		clients:        make(map[string]*RTSPClient),
		streams:        make(map[string]*CameraStream),
		ctx:            ctx,
		cancel:         cancel,
		running:        false,
		connectTimeout: 25 * time.Second,
		stallTimeout:   12 * time.Second,
	}
}

// SetWatchdog overrides the "dry stream" policy.
func (s *RTSPServer) SetWatchdog(connectTimeout, stallTimeout time.Duration) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if connectTimeout > 0 {
		s.connectTimeout = connectTimeout
	}
	if stallTimeout > 0 {
		s.stallTimeout = stallTimeout
	}
}

// NoteSessionError records a fatal session problem for the health endpoint.
func (s *RTSPServer) NoteSessionError(kind ErrKind, err error) {
	if err == nil {
		return
	}
	s.mutex.Lock()
	s.lastSessionError = err.Error()
	s.lastSessionErrKind = string(kind)
	s.lastSessionErrAt = time.Now()
	s.mutex.Unlock()
}

func (s *RTSPServer) Start() error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	if s.running {
		return errors.New("server is already running")
	}

	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", s.port))
	if err != nil {
		return fmt.Errorf("failed to listen on port %d: %v", s.port, err)
	}

	s.listener = listener
	s.running = true

	core.Logger.Info().Msgf("RTSP Server started on port %d", s.port)
	core.Logger.Info().Msgf("Available endpoints:")

	// List available camera endpoints
	if err := s.printAvailableEndpoints(); err != nil {
		core.Logger.Warn().Msgf("Could not list camera endpoints: %v", err)
	}

	// Start accepting connections
	go s.acceptConnections()

	// Start cleanup routine
	go s.cleanupRoutine()

	// Start media watchdog: the thing that was missing. A stream object in
	// the map used to be treated as "camera works"; it is only a registration.
	go s.mediaWatchdog()

	return nil
}

func (s *RTSPServer) Stop() error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	if !s.running {
		return errors.New("server is not running")
	}

	core.Logger.Info().Msg("Stopping RTSP server...")

	// Cancel context to stop all goroutines
	s.running = false
	s.cancel()

	// Close listener
	if s.listener != nil {
		s.listener.Close()
	}

	// Close all client connections
	for _, client := range s.clients {
		client.conn.Close()
	}

	// Stop all streams
	for _, stream := range s.streams {
		stream.Stop()
	}

	return nil
}

func (s *RTSPServer) IsRunning() bool {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	return s.running
}

func (s *RTSPServer) GetPort() int {
	return s.port
}

func (s *RTSPServer) GetStats() ServerStats {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	activeStreams := 0
	for _, stream := range s.streams {
		if stream.active {
			activeStreams++
		}
	}

	return ServerStats{
		Port:         s.port,
		Running:      s.running,
		ClientCount:  len(s.clients),
		StreamCount:  activeStreams,
		TotalStreams: len(s.streams),
	}
}

type ServerStats struct {
	Port         int  `json:"port"`
	Running      bool `json:"running"`
	ClientCount  int  `json:"clientCount"`
	StreamCount  int  `json:"activeStreamCount"`
	TotalStreams int  `json:"totalStreams"`
}

func (s *RTSPServer) acceptConnections() {
	for s.running {
		select {
		case <-s.ctx.Done():
			return
		default:
			conn, err := s.listener.Accept()
			if err != nil {
				if s.running {
					core.Logger.Error().Err(err).Msg("Error accepting connection")
				}
				continue
			}

			// Handle connection in goroutine
			go s.handleConnection(conn)
		}
	}
}

func (s *RTSPServer) handleConnection(conn net.Conn) {
	defer conn.Close()

	session := generateSessionID()
	core.Logger.Info().Msgf("New RTSP connection established, session=%s", session)

	reader := bufio.NewReader(conn)

	// Parse initial RTSP request
	request, err := s.parseRTSPRequestFromReader(reader)
	if err != nil {
		core.Logger.Error().Err(err).Msg("Error parsing initial RTSP request")
		return
	}

	// Extract camera path from URL
	cameraPath, streamResolution := extractCameraPath(request.URL)
	if cameraPath == "" {
		core.Logger.Error().Msg("Invalid RTSP URL")
		sendRTSPResponse(conn, 400, "Bad Request", nil, "")
		return
	}

	// Find camera
	camera, user, err := s.findCamera(cameraPath)
	if err != nil {
		core.Logger.Error().Msgf("Error finding camera for path %s: %v", cameraPath, err)
		sendRTSPResponse(conn, 500, "Internal Server Error", nil, "")
		return
	}

	if camera == nil {
		core.Logger.Error().Msgf("Camera not found for path %s", cameraPath)
		sendRTSPResponse(conn, 404, "Not Found", nil, "")
		return
	}

	core.Logger.Info().Msgf("New RTSP connection for camera: %s (%s)", camera.DeviceName, camera.DeviceID)

	// Create or get existing stream
	stream, err := s.getOrCreateStream(camera, streamResolution, user)
	if err != nil {
		core.Logger.Error().Err(err).Msgf("Failed to create stream for camera %s", camera.DeviceName)
		sendRTSPResponse(conn, 500, "Internal Server Error", nil, "Failed to create stream")
		return
	}

	// Create RTSP client
	client := &RTSPClient{
		conn:                conn,
		reader:              reader,
		session:             session,
		cameraPath:          cameraPath,
		stream:              stream,
		transportMode:       TransportUDP, // Default to UDP
		videoRTPPort:        0,
		audioRTPPort:        0,
		backAudioRTPPort:    0,
		videoRTPChannel:     0,
		audioRTPChannel:     2,
		backAudioRTPChannel: 4,
		setupCount:          0,
	}

	// Add client to server and stream
	s.addClient(client)
	stream.AddClient(client)

	// Handle initial request
	s.handleRTSPMethod(client, request)

	// Handle further requests
	s.handleRTSPProtocol(client)
}

func (s *RTSPServer) findCamera(path string) (*storage.CameraInfo, *storage.UserSession, error) {
	cameras, err := s.storageManager.GetAllCameras()
	if err != nil {
		return nil, nil, err
	}

	// Find camera by RTSP path
	for _, camera := range cameras {
		if camera.RTSPPath == path {
			// Get user for this camera
			users, err := s.storageManager.ListUsers()
			if err != nil {
				continue
			}

			for _, user := range users {
				if user.UserKey == camera.UserKey {
					return &camera, &user, nil
				}
			}
		}
	}

	return nil, nil, nil
}

func (s *RTSPServer) getOrCreateStream(camera *storage.CameraInfo, streamResolution string, user *storage.UserSession) (*CameraStream, error) {
	s.mutex.Lock()
	streamId := fmt.Sprintf("%s-%s", camera.DeviceID, streamResolution)
	connectTimeout := s.connectTimeout
	var stale *CameraStream
	if stream, exists := s.streams[streamId]; exists {
		if stream.usable(connectTimeout) {
			core.Logger.Trace().Msgf("Reusing existing stream for camera: %s", camera.DeviceName)
			stream.touch()
			s.mutex.Unlock()
			return stream, nil
		}
		// Dead stream still registered. Reusing it is EXACTLY the zombie the
		// dashboard used to show forever: the client got a 200 on PLAY and
		// then zero bytes. Drop it and build a fresh one.
		core.Logger.Warn().Msgf("Discarding unhealthy stream for camera %s (%s)", camera.DeviceName, stream.healthState())
		delete(s.streams, streamId)
		stale = stream
	}
	s.mutex.Unlock()

	// Stop the stale stream OUTSIDE the server lock: stopStreamInternal ends
	// up calling removeStream, which needs that same lock.
	if stale != nil {
		stale.Stop()
	}

	s.mutex.Lock()
	defer s.mutex.Unlock()

	// Re-check: another connection may have created it while we unlocked.
	if stream, exists := s.streams[streamId]; exists && stream.usable(connectTimeout) {
		core.Logger.Trace().Msgf("Reusing existing stream for camera: %s", camera.DeviceName)
		stream.touch()
		return stream, nil
	}

	stream := NewCameraStream(camera, streamResolution, user, s.storageManager, s)
	stream.connecting = true
	stream.connectingSince = time.Now()

	stream.webrtcBridge.OnError = func(err error) {
		stream.recordError(err)
		if stream.shouldStopOnError() {
			core.Logger.Error().Err(err).Msgf("WebRTC error for camera %s", camera.DeviceName)
			// Async: this can be reached while startStream holds stream.mutex.
			go stream.stopStreamInternal()
		}
	}

	s.streams[streamId] = stream

	core.Logger.Info().Msgf("Created new stream for camera: %s", camera.DeviceName)
	return stream, nil
}

// usable: can this stream still deliver media? "active" alone is not enough —
// it used to be set right after Start() returned, before a single RTP packet
// existed. A stream that is connecting but has already blown its connect
// budget, or that has stopped delivering media, must not be handed out.
//
// The connect timeout is a PARAMETER on purpose: reading it back from
// cs.server here would take the server lock while the caller already holds
// it as a writer, and Go's RWMutex is not reentrant. That inversion
// self-deadlocked the whole server: /media, o watchdog e o cleanup ficavam
// parados para sempre — exatamente enquanto a câmera estava ruim.
func (cs *CameraStream) usable(connectTimeout time.Duration) bool {
	cs.mutex.RLock()
	defer cs.mutex.RUnlock()

	if !cs.active && !cs.connecting {
		return false
	}
	if cs.connecting {
		return connectTimeout <= 0 ||
			time.Since(cs.connectingSince) < connectTimeout
	}
	// Active. Live, or still inside its grace period after coming up?
	if cs.everStreamedLocked() {
		return true
	}
	return time.Since(cs.activeSince) < connectTimeout
}

func (cs *CameraStream) touch() {
	cs.mutex.Lock()
	cs.lastActivity = time.Now()
	cs.mutex.Unlock()
}

func (s *RTSPServer) removeStream(streamId string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	if _, exists := s.streams[streamId]; exists {
		delete(s.streams, streamId)
		core.Logger.Trace().Msgf("Removed stream %s from server map", streamId)
	}
}

func (s *RTSPServer) addClient(client *RTSPClient) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.clients[client.session] = client
}

func (s *RTSPServer) removeClient(sessionID string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	if client, exists := s.clients[sessionID]; exists {
		// Remove client from stream
		if client.stream != nil {
			client.stream.RemoveClient(sessionID)
		}

		client.conn.Close()
		delete(s.clients, sessionID)
	}
}

func (s *RTSPServer) printAvailableEndpoints() error {
	cameras, err := s.storageManager.GetAllCameras()
	if err != nil {
		return err
	}

	if len(cameras) == 0 {
		core.Logger.Warn().Msg("  No cameras available. Run 'cameras refresh' first.")
		return nil
	}

	for _, camera := range cameras {
		var skill *tuya.Skill
		json.Unmarshal([]byte(camera.Skill), &skill)

		supportClarity := skill != nil && (skill.WebRTC&(1<<5)) != 0
		baseUrl := fmt.Sprintf("rtsp://localhost:%d%s", s.port, camera.RTSPPath)

		if supportClarity {
			core.Logger.Info().Msgf("  %s/hd (%s)", baseUrl, camera.DeviceName)
			core.Logger.Info().Msgf("  %s/sd (%s)", baseUrl, camera.DeviceName)
		} else {
			core.Logger.Info().Msgf("  %s (%s)", baseUrl, camera.DeviceName)
		}
	}

	return nil
}

func (s *RTSPServer) cleanupRoutine() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.cleanupInactiveStreams()
		}
	}
}

func (s *RTSPServer) cleanupInactiveStreams() {
	s.mutex.Lock()
	var victims []*CameraStream
	now := time.Now()
	for deviceID, stream := range s.streams {
		// Remove streams inactive for more than 5 minutes
		if now.Sub(stream.lastActivity) > 5*time.Minute && len(stream.clients) == 0 {
			core.Logger.Trace().Msgf("Cleaning up inactive stream for camera: %s", stream.camera.DeviceName)
			victims = append(victims, stream)
			delete(s.streams, deviceID)
		}
	}
	s.mutex.Unlock()

	// Stop outside the lock: Stop() reaches back into removeStream().
	for _, st := range victims {
		st.Stop()
	}
}

// mediaWatchdog is the fix for the recurring InvalidDataError.
//
// The failure it exists for: process alive, stream registered, PLAY answered
// 200, zero RTP — forever, because nothing ever asked "is media flowing?".
// Two budgets:
//   - connecting for longer than connectTimeout: the WebRTC/MQTT handshake is
//     never going to finish (usually a dead session).
//   - active but no video packet for stallTimeout: the camera went silent.
//
// On a hit it tears the stream down AND kicks the RTSP clients, so the reader
// gets a closed socket and a real error instead of hanging on a dead socket.
// The next reader then rebuilds the stream from scratch.
func (s *RTSPServer) mediaWatchdog() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.checkStreamsForStall()
		}
	}
}

func (s *RTSPServer) checkStreamsForStall() {
	s.mutex.RLock()
	streams := make([]*CameraStream, 0, len(s.streams))
	for _, st := range s.streams {
		streams = append(streams, st)
	}
	connectTimeout := s.connectTimeout
	stallTimeout := s.stallTimeout
	s.mutex.RUnlock()

	for _, st := range streams {
		verdict, reason := st.stallVerdict(connectTimeout, stallTimeout)
		if verdict == "" {
			continue
		}
		core.Logger.Warn().Msgf("Camera %s: %s", st.camera.DeviceName, reason)
		s.handleStall(st, reason)
	}
}

func (s *RTSPServer) handleStall(st *CameraStream, reason string) {
	clients := st.kickClients()
	core.Logger.Warn().Msgf("Tearing down stalled stream for %s (%s), %d client(s) disconnected",
		st.camera.DeviceName, reason, len(clients))
	s.emitMedia(st, "stalled", reason)
	st.Stop()
}

// emitMedia prints one machine-readable line per notable media transition.
// The Python backend tails these for the dashboard log; the authoritative
// source is the /media health endpoint.
func (s *RTSPServer) emitMedia(st *CameraStream, state, detail string) {
	h := st.Health()
	fmt.Printf("NEBULA_MEDIA path=%s state=%s pkts=%d bytes=%d age=%.1f detail=%s\n",
		h.Path, state, h.Media.VideoPackets, h.Media.VideoBytes,
		h.Media.LastPacketAge, sanitizeField(detail))
	os.Stdout.Sync()
}

func sanitizeField(v string) string {
	v = strings.ReplaceAll(v, " ", "_")
	v = strings.ReplaceAll(v, "\t", "_")
	v = strings.ReplaceAll(v, "\n", "_")
	if len(v) > 160 {
		v = v[:160]
	}
	return v
}

// kickClients closes the RTSP sessions of a stream so a blocked reader wakes
// up. Returns the kicked session ids.
func (cs *CameraStream) kickClients() []string {
	cs.mutex.Lock()
	sessions := make([]string, 0, len(cs.clients))
	for sid := range cs.clients {
		sessions = append(sessions, sid)
	}
	cs.mutex.Unlock()

	for _, sid := range sessions {
		if cs.server != nil {
			cs.server.removeClient(sid)
		}
	}
	return sessions
}

// Health returns ground truth for one camera.
func (cs *CameraStream) Health() CameraHealth {
	cs.mutex.RLock()
	h := CameraHealth{
		Path:       cs.camera.RTSPPath,
		Name:       cs.camera.DeviceName,
		DeviceID:   cs.camera.DeviceID,
		Registered: true,
		Connecting: cs.connecting,
		Active:     cs.active,
		Clients:    len(cs.clients),
		LastError:  cs.lastError,
		ErrorKind:  string(cs.lastErrKind),
		Restarts:   cs.restarts,
	}
	if !cs.connectingSince.IsZero() {
		h.ConnectingFor = time.Since(cs.connectingSince).Seconds()
	}
	if !cs.activeSince.IsZero() {
		h.ActiveFor = time.Since(cs.activeSince).Seconds()
	}
	if !cs.lastErrAt.IsZero() {
		h.LastErrorAt = time.Since(cs.lastErrAt).Seconds()
	}
	cs.mutex.RUnlock()

	if cs.webrtcBridge != nil {
		bs := cs.webrtcBridge.Status()
		h.Connected = bs.Connected
		h.Media = bs.Media
		if bs.LastError != "" && h.LastError == "" {
			h.LastError = bs.LastError
			h.ErrorKind = bs.ErrorKind
		}
	}
	h.State = cs.computeState()
	return h
}

func (cs *CameraStream) computeState() string {
	cs.mutex.RLock()
	connecting, active := cs.connecting, cs.active
	stalled := !cs.stalledAt.IsZero()
	everStreamed := cs.everStreamedLocked()
	cs.mutex.RUnlock()

	switch {
	case connecting:
		return "connecting"
	case !active:
		if stalled {
			return "stalled"
		}
		return "idle"
	case everStreamed && !stalled:
		return "live"
	case stalled:
		return "stalled"
	}
	// Ativo, ninguém nunca mandou pacote, mas ainda dentro da carência.
	// Reportar "stalled" aqui derrubava negotiationsambo: medido, a câmera
	// leva ~14s entre o PLAY e o primeiro RTP, e o watchdog do Python via o
	// camera como "stalled no Go (sem RTP)" e matava a câmera no handshake.
	return "connecting"
}

func (cs *CameraStream) everStreamedLocked() bool {
	if cs.webrtcBridge == nil || cs.webrtcBridge.rtpForwarder == nil {
		return false
	}
	return cs.webrtcBridge.rtpForwarder.MediaStats().VideoPackets > 0
}

// stallVerdict returns ("", "") when the stream is healthy.
func (cs *CameraStream) stallVerdict(connectTimeout, stallTimeout time.Duration) (string, string) {
	cs.mutex.Lock()
	defer cs.mutex.Unlock()

	if cs.connecting {
		if !cs.connectingSince.IsZero() &&
			time.Since(cs.connectingSince) > connectTimeout {
			cs.connecting = false
			return "stalled", fmt.Sprintf("handshake_webrtc_sem_media_apos_%ds", int(connectTimeout.Seconds()))
		}
		return "", ""
	}

	if !cs.active {
		cs.stalledAt = time.Time{}
		return "", ""
	}

	if cs.webrtcBridge != nil && cs.webrtcBridge.rtpForwarder != nil {
		ms := cs.webrtcBridge.rtpForwarder.MediaStats()
		grace := connectTimeout
		if ms.VideoPackets > 0 && ms.LastPacketAge > stallTimeout.Seconds() {
			cs.stalledAt = time.Now()
			cs.active = false
			return "stalled", fmt.Sprintf("media_parou_ha_%ds", int(ms.LastPacketAge))
		}
		if ms.VideoPackets == 0 && time.Since(cs.activeSince) > grace {
			cs.stalledAt = time.Now()
			cs.active = false
			return "stalled", "conectou_mas_nunca_chegou_rtp"
		}
	}
	return "", ""
}

func (cs *CameraStream) recordError(err error) {
	cs.mutex.Lock()
	cs.lastError = err.Error()
	cs.lastErrAt = time.Now()
	if be, ok := err.(*BridgeError); ok {
		cs.lastErrKind = be.Kind
	} else if k := classify(err, "unknown"); k != KindUnknown {
		cs.lastErrKind = k
	}
	cs.mutex.Unlock()
}

func (cs *CameraStream) shouldStopOnError() bool {
	cs.mutex.RLock()
	defer cs.mutex.RUnlock()
	return cs.active || cs.connecting
}

func (cs *CameraStream) healthState() string {
	h := cs.Health()
	return fmt.Sprintf("state=%s pkts=%d age=%.1fs err=%s", h.State,
		h.Media.VideoPackets, h.Media.LastPacketAge, h.LastError)
}

// CamerasHealth is the whole-server snapshot used by /media.
type CamerasHealth struct {
	Running     bool           `json:"running"`
	Port        int            `json:"port"`
	Now         string         `json:"now"`
	ConnectTO   float64        `json:"connectTimeoutSec"`
	StallTO     float64        `json:"stallTimeoutSec"`
	Cameras     []CameraHealth `json:"cameras"`
	LastError   string         `json:"lastSessionError,omitempty"`
	LastErrKind string         `json:"lastSessionErrorKind,omitempty"`
	LastErrAge  float64        `json:"lastSessionErrorAgeSec,omitempty"`
}

func (s *RTSPServer) Health() CamerasHealth {
	s.mutex.RLock()
	streams := make([]*CameraStream, 0, len(s.streams))
	for _, st := range s.streams {
		streams = append(streams, st)
	}
	out := CamerasHealth{
		Running:   s.running,
		Port:      s.port,
		Now:       time.Now().UTC().Format(time.RFC3339Nano),
		ConnectTO: s.connectTimeout.Seconds(),
		StallTO:   s.stallTimeout.Seconds(),
		Cameras:   make([]CameraHealth, 0, len(streams)),
		LastError: s.lastSessionError, LastErrKind: s.lastSessionErrKind,
	}
	if !s.lastSessionErrAt.IsZero() {
		out.LastErrAge = time.Since(s.lastSessionErrAt).Seconds()
	}
	s.mutex.RUnlock()

	// Cameras known by discovery but with no live stream object still have to
	// appear: "registered" is not the same as "never tried".
	registered := map[string]bool{}
	for _, st := range streams {
		out.Cameras = append(out.Cameras, st.Health())
		registered[st.camera.RTSPPath] = true
	}
	if cams, err := s.storageManager.GetAllCameras(); err == nil {
		for _, c := range cams {
			if registered[c.RTSPPath] {
				continue
			}
			out.Cameras = append(out.Cameras, CameraHealth{
				Path: c.RTSPPath, Name: c.DeviceName, DeviceID: c.DeviceID,
				Registered: false, State: "idle",
			})
		}
	}
	sort.Slice(out.Cameras, func(i, j int) bool { return out.Cameras[i].Path < out.Cameras[j].Path })
	return out
}

// RestartCamera forces a clean teardown of one stream. The next reader that
// arrives rebuilds it with a fresh MQTT session and a fresh offer — that is
// the difference between "reconnect the reader" (what failed) and "rebuild the
// pipeline".
func (s *RTSPServer) RestartCamera(deviceIDOrPath string) bool {
	s.mutex.Lock()
	var victims []*CameraStream
	for id, st := range s.streams {
		if st.camera.DeviceID == deviceIDOrPath || st.camera.RTSPPath == deviceIDOrPath {
			victims = append(victims, st)
			delete(s.streams, id)
		}
	}
	s.mutex.Unlock()

	for _, st := range victims {
		st.kickClients()
		st.Stop()
	}
	return len(victims) > 0
}

func NewCameraStream(camera *storage.CameraInfo, resolution string, user *storage.UserSession, storageManager *storage.StorageManager, server *RTSPServer) *CameraStream {
	stream := &CameraStream{
		camera:        camera,
		resolution:    resolution,
		user:          user,
		clients:       make(map[string]*RTSPClient),
		active:        false,
		lastActivity:  time.Now(),
		shutdownDelay: 5 * time.Second,
		server:        server,
		streamId:      fmt.Sprintf("%s-%s", camera.DeviceID, resolution),
	}

	stream.webrtcBridge = NewWebRTCBridge(camera, resolution, user, storageManager)

	return stream
}

func (cs *CameraStream) AddClient(client *RTSPClient) {
	cs.mutex.Lock()
	defer cs.mutex.Unlock()

	// Cancel any pending shutdown
	if cs.shutdownTimer != nil {
		cs.shutdownTimer.Stop()
		cs.shutdownTimer = nil
		core.Logger.Trace().Msgf("Cancelled pending shutdown for camera %s - new client connected", cs.camera.DeviceName)
	}

	cs.clients[client.session] = client
	cs.lastActivity = time.Now()

	// Start stream if not active AND no handshake already running.
	if !cs.active && !cs.starting {
		go cs.startStream()
	}
}

func (cs *CameraStream) RemoveClient(sessionID string) {
	cs.mutex.Lock()
	defer cs.mutex.Unlock()

	// Remove from RTP forwarder
	if cs.webrtcBridge != nil && cs.webrtcBridge.rtpForwarder != nil {
		cs.webrtcBridge.rtpForwarder.RemoveClient(sessionID)
	}

	delete(cs.clients, sessionID)
	cs.lastActivity = time.Now()

	// Schedule stream shutdown if no clients and stream is active
	if len(cs.clients) == 0 && cs.active {
		cs.scheduleShutdown()
	}
}

func (cs *CameraStream) SetShutdownDelay(delay time.Duration) {
	cs.mutex.Lock()
	defer cs.mutex.Unlock()
	cs.shutdownDelay = delay
}

func (cs *CameraStream) Stop() {
	// Clear all clients first
	for sessionID := range cs.clients {
		cs.RemoveClient(sessionID)
	}

	// Stop the stream
	cs.stopStream()
}

func (cs *CameraStream) startStream() {
	cs.mutex.Lock()
	if cs.active || cs.starting {
		cs.mutex.Unlock()
		return
	}
	cs.starting = true
	cs.connecting = true
	cs.connectingSince = time.Now()
	cs.mutex.Unlock()

	core.Logger.Info().Msgf("Starting stream for camera: %s", cs.camera.DeviceName)

	// Start() can take tens of seconds (MQTT + offer/answer). Holding the
	// stream mutex across it made every other path on this stream block —
	// including the error callback that needs to stop it.
	if err := cs.webrtcBridge.Start(); err != nil {
		cs.recordError(err)
		core.Logger.Error().Err(err).Msg("Failed to start WebRTC bridge")
		cs.stopStreamInternal()
		return
	}

	cs.mutex.Lock()
	cs.starting = false
	cs.connecting = false
	cs.active = true
	cs.activeSince = time.Now()
	cs.lastActivity = time.Now()
	cs.mutex.Unlock()

	// "active" is not "live". Say so out loud, and let the watchdog decide
	// what happens if the picture never arrives.
	if cs.webrtcBridge.rtpForwarder != nil {
		if cs.webrtcBridge.rtpForwarder.MediaStats().VideoPackets > 0 {
			cs.notifyServerMedia("live", "")
		} else {
			cs.notifyServerMedia("connecting", "webrtc_up_sem_rtp")
		}
	}
}

func (cs *CameraStream) notifyServerMedia(state, detail string) {
	if cs.server != nil {
		cs.server.emitMedia(cs, state, detail)
	}
}

func (cs *CameraStream) stopStream() {
	cs.mutex.Lock()
	defer cs.mutex.Unlock()
	cs.stopStreamInternal()
}

func (cs *CameraStream) stopStreamInternal() {
	// Check if we should actually stop
	if !cs.active && !cs.connecting {
		return
	}

	wasActive := cs.active
	cs.active = false
	cs.connecting = false
	cs.starting = false
	cs.stalledAt = time.Time{}
	cs.connectingSince = time.Time{}
	cs.activeSince = time.Time{}
	cs.restarts++

	// Cancel any pending shutdown
	if cs.shutdownTimer != nil {
		cs.shutdownTimer.Stop()
		cs.shutdownTimer = nil
	}

	// Only log if we were actually active
	if wasActive {
		core.Logger.Info().Msgf("Stopping stream for camera: %s", cs.camera.DeviceName)
	}

	// Stop WebRTC bridge.
	//
	// Síncrono e ainda segurando a trava do stream: um cliente que chega no
	// meio da janela de parada seagia num stream moribundo, e a câmera
	// (aceita um cliente por vez) ficava sem responder — a sondagem falhava
	// ~50% das vezes mesmo com a câmera saudável. Isso é seguro agora que
	// `handleError` notifica em goroutine (nada aqui volta a pedir cs.mutex),
	// e a remoção do mapa continua em goroutine para não pegar s.mutex.
	if cs.webrtcBridge != nil {
		cs.webrtcBridge.Stop()
	}

	// Remove from server map in a separate goroutine to avoid potential deadlock
	go func() {
		if cs.server != nil {
			cs.server.removeStream(cs.streamId)
		}
	}()
}

func (cs *CameraStream) scheduleShutdown() {
	// Don't schedule if we're not active
	if !cs.active {
		return
	}

	// Cancel any existing timer
	if cs.shutdownTimer != nil {
		cs.shutdownTimer.Stop()
	}

	core.Logger.Trace().Msgf("Scheduling shutdown for camera %s in %v", cs.camera.DeviceName, cs.shutdownDelay)

	cs.shutdownTimer = time.AfterFunc(cs.shutdownDelay, func() {
		cs.mutex.Lock()
		defer cs.mutex.Unlock()

		// Double-check no clients connected during the delay and stream is still active
		if len(cs.clients) == 0 && cs.active {
			core.Logger.Info().Msgf("Executing delayed shutdown for camera %s", cs.camera.DeviceName)
			cs.stopStreamInternal()
		}

		cs.shutdownTimer = nil
	})
}
