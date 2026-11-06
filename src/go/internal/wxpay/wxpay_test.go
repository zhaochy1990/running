// wxpay_test.go exercises the notify contract offline (devops#904: no real
// WeChat integration): a throwaway RSA pair stands in for the WeChat Pay
// platform public key, signatures and AEAD_AES_256_GCM payloads are crafted
// with test keys, and the verification path runs through the SDK's own
// notify.Handler + SHA256WithRSAPubkeyVerifier — the same public-key-mode
// machinery production uses, pointed at the test key instead of the real one.
package wxpay

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/wechatpay-apiv3/wechatpay-go/core"
	"github.com/wechatpay-apiv3/wechatpay-go/core/auth/verifiers"
	"github.com/wechatpay-apiv3/wechatpay-go/core/consts"
	"github.com/wechatpay-apiv3/wechatpay-go/core/notify"
	"github.com/wechatpay-apiv3/wechatpay-go/utils"
)

const (
	testAPIv3Key = "0123456789abcdef0123456789abcdef" // exactly 32 bytes
	// testPubKeyID is the Wechatpay-Serial value a callback would carry for
	// the test public key (the verifier pins the key by it).
	testPubKeyID    = "PUB_KEY_ID_test0000000000000000000000"
	testNotifyNonce = "123456789012" // AES-GCM nonce size
)

func testConfig() Config {
	return Config{
		AppID: "wx-test-appid", MchID: "1900000001", MerchantSerialNo: "test-mch-serial",
		PrivateKeyPEM: "placeholder", PublicKeyID: testPubKeyID,
		PublicKeyPEM: "placeholder", APIv3Key: testAPIv3Key,
		NotifyURL: "https://api.example.com/api/wxpay/notify",
	}
}

// newTestPlatform returns a throwaway RSA pair standing in for the WeChat Pay
// platform key pair, plus the public half as PEM text (what the config ships).
func newTestPlatform(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen platform key: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	pubPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	return key, pubPEM
}

// newTestClient builds a Client whose notify path trusts only the test WeChat
// Pay public key, parsed through the same utils.LoadPublicKey + pubkey
// verifier chain production runs. The jsapi half stays nil — the offline
// suite covers the callback contract and the close-order classification, the
// pieces real WeChat credentials gate.
func newTestClient(t *testing.T, cfg Config, platformPubPEM string) *Client {
	t.Helper()
	pubKey, err := utils.LoadPublicKey(platformPubPEM)
	if err != nil {
		t.Fatalf("load platform public key: %v", err)
	}
	handler, err := notify.NewRSANotifyHandler(
		cfg.APIv3Key,
		verifiers.NewSHA256WithRSAPubkeyVerifier(cfg.PublicKeyID, *pubKey),
	)
	if err != nil {
		t.Fatalf("notify handler: %v", err)
	}
	return &Client{cfg: cfg, notify: handler}
}

// sealResource AES-256-GCM-encrypts the callback plaintext the way WeChat
// does under the APIv3 key; aesKey lets a test seal with a wrong key too.
func sealResource(t *testing.T, plaintext []byte, aesKey []byte, associatedData, nonce string) string {
	t.Helper()
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		t.Fatalf("new cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("new gcm: %v", err)
	}
	sealed := gcm.Seal(nil, []byte(nonce), plaintext, []byte(associatedData))
	return base64.StdEncoding.EncodeToString(sealed)
}

// notifyRequest builds one authenticated callback request: the body's
// resource carries the encrypted transaction, and the envelope is signed with
// the given platform key over timestamp\nnonce\nbody\n — the SDK validator's
// exact message.
func notifyRequest(t *testing.T, body map[string]any, signingKey *rsa.PrivateKey, platformSerial string) *http.Request {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal notify body: %v", err)
	}
	return signedNotifyRequest(t, raw, signingKey, platformSerial)
}

// signedNotifyRequest signs raw (the exact verification message) and ships it
// in the request body, so a caller may send different bytes than it signed
// (the tamper test).
func signedNotifyRequest(t *testing.T, raw []byte, signingKey *rsa.PrivateKey, serial string) *http.Request {
	t.Helper()
	stamp := time.Now().Unix()
	nonce := testNotifyNonce
	signature, err := utils.SignSHA256WithRSA(
		strconv.FormatInt(stamp, 10)+"\n"+nonce+"\n"+string(raw)+"\n", signingKey)
	if err != nil {
		t.Fatalf("sign notify: %v", err)
	}
	req := httptest.NewRequest("POST", "/api/wxpay/notify", bytes.NewReader(raw))
	req.Header.Set(consts.WechatPayTimestamp, strconv.FormatInt(stamp, 10))
	req.Header.Set(consts.WechatPayNonce, nonce)
	req.Header.Set(consts.WechatPaySignature, signature)
	req.Header.Set(consts.WechatPaySerial, serial)
	return req
}

// successNotifyBody crafts the full callback envelope for a SUCCESS
// transaction, AEAD-sealed under the APIv3 key.
func successNotifyBody(t *testing.T, tradeState string, totalFen int64) map[string]any {
	t.Helper()
	plaintext, err := json.Marshal(map[string]any{
		"out_trade_no": "order-1",
		"trade_state":  tradeState,
		"amount":       map[string]any{"total": totalFen},
	})
	if err != nil {
		t.Fatalf("marshal transaction: %v", err)
	}
	return map[string]any{
		"id":         "evt-1",
		"event_type": "TRANSACTION.SUCCESS",
		"resource": map[string]any{
			"algorithm":       "AEAD_AES_256_GCM",
			"nonce":           testNotifyNonce,
			"associated_data": "transaction",
			"ciphertext":      sealResource(t, plaintext, []byte(testAPIv3Key), "transaction", testNotifyNonce),
		},
	}
}

func TestConfigured(t *testing.T) {
	if (*Client)(nil).Configured() {
		t.Fatal("nil client must report unconfigured")
	}
	cfg := testConfig()
	if !cfg.Configured() {
		t.Fatal("complete config must report configured")
	}
	for _, zero := range []func(*Config){func(c *Config) { c.AppID = "" }, func(c *Config) { c.MchID = "" }, func(c *Config) { c.MerchantSerialNo = "" }, func(c *Config) { c.PrivateKeyPEM = "" }, func(c *Config) { c.PublicKeyID = "" }, func(c *Config) { c.PublicKeyPEM = "" }, func(c *Config) { c.APIv3Key = "" }, func(c *Config) { c.NotifyURL = "" }} {
		partial := testConfig()
		zero(&partial)
		if partial.Configured() {
			t.Fatalf("config with one empty field must report unconfigured: %+v", partial)
		}
	}
}

func TestParseNotifyVerifiedSuccess(t *testing.T) {
	platformKey, platformPubPEM := newTestPlatform(t)
	client := newTestClient(t, testConfig(), platformPubPEM)

	rec := notifyRequest(t, successNotifyBody(t, TradeStateSuccess, 500), platformKey, testPubKeyID)
	got, err := client.ParseNotify(context.Background(), rec)
	if err != nil {
		t.Fatalf("parse verified notify: %v", err)
	}
	if got.OutTradeNo != "order-1" || got.TradeState != TradeStateSuccess || got.PaidFen != 500 {
		t.Fatalf("unexpected notify payload: %+v", got)
	}
}

func TestParseNotifyNonSuccessStateStillVerified(t *testing.T) {
	platformKey, platformPubPEM := newTestPlatform(t)
	client := newTestClient(t, testConfig(), platformPubPEM)

	rec := notifyRequest(t, successNotifyBody(t, "CLOSED", 500), platformKey, testPubKeyID)
	got, err := client.ParseNotify(context.Background(), rec)
	if err != nil {
		t.Fatalf("parse closed-state notify: %v", err)
	}
	if got.TradeState != "CLOSED" {
		t.Fatalf("expected CLOSED passthrough, got %+v", got)
	}
}

func TestParseNotifyRejectsForeignSignature(t *testing.T) {
	_, platformPubPEM := newTestPlatform(t)
	foreignKey, _ := newTestPlatform(t)
	client := newTestClient(t, testConfig(), platformPubPEM)

	rec := notifyRequest(t, successNotifyBody(t, TradeStateSuccess, 500), foreignKey, testPubKeyID)
	if _, err := client.ParseNotify(context.Background(), rec); err == nil {
		t.Fatal("a signature from an untrusted key must be rejected")
	}
}

func TestParseNotifyRejectsForeignSerial(t *testing.T) {
	platformKey, platformPubPEM := newTestPlatform(t)
	client := newTestClient(t, testConfig(), platformPubPEM)

	// The pubkey verifier pins the key by the Wechatpay-Serial header: a
	// callback naming any other serial (a platform-cert serial, a rotated key
	// id) must be refused before the signature even matters.
	rec := notifyRequest(t, successNotifyBody(t, TradeStateSuccess, 500), platformKey, "PUB_KEY_ID_other")
	if _, err := client.ParseNotify(context.Background(), rec); err == nil {
		t.Fatal("a callback with a foreign Wechatpay-Serial must be rejected")
	}
}

func TestParseNotifyRejectsTamperedBody(t *testing.T) {
	platformKey, platformPubPEM := newTestPlatform(t)
	client := newTestClient(t, testConfig(), platformPubPEM)

	raw, err := json.Marshal(successNotifyBody(t, TradeStateSuccess, 500))
	if err != nil {
		t.Fatalf("marshal notify body: %v", err)
	}
	// Sign the honest bytes, ship a mutated body: the validator must read the
	// body it verifies and reject the mismatch.
	req := signedNotifyRequest(t, raw, platformKey, testPubKeyID)
	req.Body = io.NopCloser(bytes.NewReader(append(raw, ' ')))
	if _, err := client.ParseNotify(context.Background(), req); err == nil {
		t.Fatal("a body mutated after signing must be rejected")
	}
}

func TestParseNotifyRejectsForeignCiphertext(t *testing.T) {
	platformKey, platformPubPEM := newTestPlatform(t)
	client := newTestClient(t, testConfig(), platformPubPEM)

	plaintext, err := json.Marshal(map[string]any{"out_trade_no": "order-1", "trade_state": "SUCCESS"})
	if err != nil {
		t.Fatalf("marshal transaction: %v", err)
	}
	body := successNotifyBody(t, TradeStateSuccess, 500)
	resource := body["resource"].(map[string]any)
	resource["ciphertext"] = sealResource(t, plaintext, []byte("0123456789abcdef0123456789abcdeX"), "transaction", testNotifyNonce)

	rec := notifyRequest(t, body, platformKey, testPubKeyID)
	if _, err := client.ParseNotify(context.Background(), rec); err == nil {
		t.Fatal("a payload sealed under another key must be rejected")
	}
}

func TestCloseOrderClassifiesInertCodes(t *testing.T) {
	for code, expectInert := range map[string]bool{
		"ORDER_NOT_EXIST": true,  // never prepaid — nothing to close, refund may proceed
		"ORDER_CLOSED":    true,  // a previous sweep closed it — finish the refund
		"ORDERPAID":       false, // money moved — never refund on this
		"SYSTEM_ERROR":    false, // transient — retry next sweep
	} {
		err := closeErrClassify(&core.APIError{Code: code})
		if expectInert && err != nil {
			t.Fatalf("code %s should be inert (nil error), got %v", code, err)
		}
		if !expectInert && err == nil {
			t.Fatalf("code %s should stay an error, got nil", code)
		}
	}
	if err := closeErrClassify(errors.New("plain network failure")); err == nil {
		t.Fatal("non-API errors must stay errors")
	}
}
