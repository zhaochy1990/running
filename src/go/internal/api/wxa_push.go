// wxa_push.go receives the WeChat miniprogram message push for the feedback
// image-moderation results (event `wxa_media_check`, devops#552). It implements
// the message-push verification contract directly: the Token SHA1 signature on
// every request, the GET echostr handshake, and — for safe/compatible mode —
// the EncodingAESKey AES-128-CBC payload decryption with the receiveid check.
// The message format (JSON or XML) is a console-side choice, so both parse.
package api

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/storage"
)

// WXAPushConfig carries the miniprogram console's message-push credentials.
// An empty Token leaves the endpoints at 404 (P6 supplies them via env).
type WXAPushConfig struct {
	// AppID pins the decrypted receiveid when set; empty skips the check (the
	// signature over the encrypted payload already authenticates the source).
	AppID string
	// Token is the console-configured verification token.
	Token string
	// EncodingAESKey is the 43-char base64 key for safe/compatible mode.
	EncodingAESKey string
}

// wxaSignature is the WeChat push signature: SHA1 over the lexicographically
// sorted join of the token and the request parts (timestamp, nonce, and — in
// safe/compatible mode — the Encrypt payload).
func wxaSignature(token string, parts ...string) string {
	all := append([]string{token}, parts...)
	sort.Strings(all)
	h := sha1.Sum([]byte(strings.Join(all, "")))
	return fmt.Sprintf("%x", h)
}

// wxaSignatureOK compares the expected signature in constant time (same
// discipline as the coros webhook's credential headers).
func wxaSignatureOK(got, want string) bool {
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// wxaPushBody is the union shape of the JSON and XML push payloads we care
// about: the safe-mode envelope (Encrypt) and the media-check event fields.
type wxaPushBody struct {
	Encrypt string `json:"Encrypt" xml:"Encrypt"`
	Event   string `json:"Event" xml:"Event"`
	TraceID string `json:"trace_id" xml:"trace_id"`
	Result  struct {
		Suggest string `json:"suggest" xml:"suggest"`
	} `json:"result" xml:"result"`
}

// parseWXAPush decodes either the JSON or the XML push format (the console
// format dropdown decides which one arrives).
func parseWXAPush(body []byte) (*wxaPushBody, error) {
	var out wxaPushBody
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '<' {
		if err := xml.Unmarshal(trimmed, &out); err != nil {
			return nil, fmt.Errorf("wxa push: parse xml: %w", err)
		}
		return &out, nil
	}
	if err := json.Unmarshal(trimmed, &out); err != nil {
		return nil, fmt.Errorf("wxa push: parse json: %w", err)
	}
	return &out, nil
}

// wxaDecrypt opens a safe/compatible-mode payload: base64 → AES-128-CBC with
// the EncodingAESKey, PKCS7 unpad, then strip the 16-byte random prefix and
// 4-byte network-order length; the trailing receiveid must match AppID when
// one is configured.
func wxaDecrypt(encodingAESKey, appID, cipherB64 string) ([]byte, error) {
	// The console issues the key as 43 base64 chars without the '=' pad.
	if len(encodingAESKey) == 43 {
		encodingAESKey += "="
	}
	key, err := base64.StdEncoding.DecodeString(encodingAESKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("wxa push: invalid encoding aes key")
	}
	data, err := base64.StdEncoding.DecodeString(cipherB64)
	if err != nil || len(data) < 32 || len(data)%aes.BlockSize != 0 {
		return nil, errors.New("wxa push: invalid cipher payload")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, key[:16]).CryptBlocks(plain, data)
	plain, err = pkcs7Unpad(plain, aes.BlockSize)
	if err != nil {
		return nil, err
	}
	if len(plain) < 20 {
		return nil, errors.New("wxa push: decrypted payload too short")
	}
	msgLen := binary.BigEndian.Uint32(plain[16:20])
	if int(20+msgLen) > len(plain) {
		return nil, errors.New("wxa push: decrypted length out of bounds")
	}
	receiveID := string(plain[20+msgLen:])
	if appID != "" && receiveID != appID {
		return nil, fmt.Errorf("wxa push: receiveid %q does not match appid", receiveID)
	}
	return plain[20 : 20+msgLen], nil
}

// pkcs7Unpad strips the standard padding WeChat applies before encryption.
func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, errors.New("wxa push: bad padded length")
	}
	pad := int(data[len(data)-1])
	if pad == 0 || pad > blockSize || pad > len(data) {
		return nil, errors.New("wxa push: bad padding")
	}
	for _, b := range data[len(data)-pad:] {
		if int(b) != pad {
			return nil, errors.New("wxa push: bad padding bytes")
		}
	}
	return data[:len(data)-pad], nil
}

// pushVerify serves GET /webhook/push/wxa-media-check — the console's URL
// verification handshake: echo the echostr only when the token signature
// matches.
//
//	@Summary		WeChat push URL verification
//	@Description	Echoes echostr when the Token signature matches; part of the miniprogram console message-push setup.
//	@Tags			wxa-push
//	@Param			signature	query	string	true	"SHA1(token,timestamp,nonce)"
//	@Param			timestamp	query	string	true	"Unix seconds"
//	@Param			nonce		query	string	true	"Random string"
//	@Param			echostr		query	string	true	"Random echo payload"
//	@Success		200	{object}	string
//	@Failure		403	{object}	nil
//	@Router			/webhook/push/wxa-media-check [get]
func (f *feedbackRoutes) pushVerify(c *gin.Context) {
	if f.push.Token == "" {
		c.Status(http.StatusNotFound)
		return
	}
	if !wxaSignatureOK(wxaSignature(f.push.Token, c.Query("timestamp"), c.Query("nonce")), c.Query("signature")) {
		c.Status(http.StatusForbidden)
		return
	}
	c.String(http.StatusOK, c.Query("echostr"))
}

// pushReceive serves POST /webhook/push/wxa-media-check — the event push. A
// wxa_media_check event resolves its traced image's moderation state; every
// other event is acked and ignored. Responding "success" stops WeChat's retry
// ladder; a storage error responds 500 so the push replays.
//
//	@Summary		WeChat media-check result push
//	@Description	Receives the wxa_media_check event (plain or encrypted payload, JSON or XML), verifies the Token/EncodingAESKey signatures, and updates the traced image's moderation state.
//	@Tags			wxa-push
//	@Param			signature	query	string	true	"SHA1(token,timestamp,nonce[,encrypt])"
//	@Param			timestamp	query	string	true	"Unix seconds"
//	@Param			nonce		query	string	true	"Random string"
//	@Success		200	{object}	string
//	@Failure		403	{object}	nil
//	@Failure		404	{object}	nil
//	@Failure		500	{object}	nil
//	@Router			/webhook/push/wxa-media-check [post]
func (f *feedbackRoutes) pushReceive(c *gin.Context) {
	if f.push.Token == "" {
		c.Status(http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.Status(http.StatusBadRequest)
		return
	}
	push, err := parseWXAPush(body)
	if err != nil {
		f.log.Warn("feedback: undecodable wxa push", zapErr(err))
		c.Status(http.StatusBadRequest)
		return
	}
	timestamp, nonce := c.Query("timestamp"), c.Query("nonce")
	if push.Encrypt != "" {
		// Safe/compatible mode: the signature covers the encrypted payload and
		// the truth lives inside it.
		if !wxaSignatureOK(wxaSignature(f.push.Token, timestamp, nonce, push.Encrypt), c.Query("signature")) {
			c.Status(http.StatusForbidden)
			return
		}
		plain, err := wxaDecrypt(f.push.EncodingAESKey, f.push.AppID, push.Encrypt)
		if err != nil {
			f.log.Warn("feedback: wxa push decrypt failed", zapErr(err))
			c.Status(http.StatusBadRequest)
			return
		}
		if push, err = parseWXAPush(plain); err != nil {
			f.log.Warn("feedback: undecodable decrypted wxa push", zapErr(err))
			c.Status(http.StatusBadRequest)
			return
		}
	} else if !wxaSignatureOK(wxaSignature(f.push.Token, timestamp, nonce), c.Query("signature")) {
		c.Status(http.StatusForbidden)
		return
	}

	if push.Event == "wxa_media_check" && push.TraceID != "" && storage.IsFeedbackModState(push.Result.Suggest) {
		if err := f.store.ApplyFeedbackImageCheck(c.Request.Context(), push.TraceID, push.Result.Suggest); err != nil {
			// Non-"success" makes WeChat retry the push (3 times).
			f.log.Error("feedback: apply image check failed", zap.String("trace_id", push.TraceID), zapErr(err))
			c.String(http.StatusInternalServerError, "retry")
			return
		}
	}
	c.String(http.StatusOK, "success")
}
