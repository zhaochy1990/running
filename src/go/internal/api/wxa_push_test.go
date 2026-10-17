// wxa_push_test.go pins the WeChat message-push crypto round-trip: the Token
// SHA1 signature, the safe-mode AES payload (PKCS7 + prefix/length/receiveid
// framing) and the JSON/XML payload parsers.
package api

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"testing"
)

// wxaTestKeyB64 returns a 43-char EncodingAESKey (base64 of 32 random-ish
// bytes without padding, exactly what the console issues).
func wxaTestKeyB64(t *testing.T) string {
	t.Helper()
	key := bytes.Repeat([]byte{0x5a}, 16)
	key = append(key, bytes.Repeat([]byte{0xa5}, 16)...)
	encoded := base64.StdEncoding.EncodeToString(key)
	return encoded[:43] // strip the '=' pad, as the console ships it
}

// wxaTestEncrypt is the inverse of wxaDecrypt: pad, frame, encrypt, encode.
func wxaTestEncrypt(t *testing.T, keyB64, appID string, msg []byte) string {
	t.Helper()
	if len(keyB64) == 43 {
		keyB64 += "="
	}
	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil || len(key) != 32 {
		t.Fatalf("test key: %v", err)
	}
	buf := make([]byte, 16, 16+4+len(msg)+len(appID)+aes.BlockSize)
	for i := range buf {
		buf[i] = byte(i)
	}
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(msg)))
	buf = append(buf, msg...)
	buf = append(buf, appID...)
	pad := aes.BlockSize - len(buf)%aes.BlockSize
	buf = append(buf, bytes.Repeat([]byte{byte(pad)}, pad)...)

	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	out := make([]byte, len(buf))
	cipher.NewCBCEncrypter(block, key[:16]).CryptBlocks(out, buf)
	return base64.StdEncoding.EncodeToString(out)
}

func TestWXASignature(t *testing.T) {
	// Order-independent over the parts, and sensitive to each of them.
	a := wxaSignature("tok", "1", "n")
	b := wxaSignature("tok", "n", "1")
	if a != b || len(a) != 40 {
		t.Fatalf("signature must be a stable sha1 hex: %q vs %q", a, b)
	}
	if a == wxaSignature("other", "1", "n") || a == wxaSignature("tok", "1", "n", "extra") {
		t.Fatal("signature must change with token and parts")
	}
}

func TestWXADecryptRoundTrip(t *testing.T) {
	keyB64 := wxaTestKeyB64(t)
	msg := []byte(`{"Event":"wxa_media_check","trace_id":"t1","result":{"suggest":"pass"}}`)
	encrypted := wxaTestEncrypt(t, keyB64, "wx123", msg)

	plain, err := wxaDecrypt(keyB64, "wx123", encrypted)
	if err != nil || !bytes.Equal(plain, msg) {
		t.Fatalf("round-trip: %v %q", err, plain)
	}
	// The 43-char key (no padding) must decode the same way.
	plain, err = wxaDecrypt(keyB64[:43], "wx123", encrypted)
	if err != nil || !bytes.Equal(plain, msg) {
		t.Fatalf("unpadded key round-trip: %v %q", err, plain)
	}
	// A mismatched receiveid is refused.
	if _, err := wxaDecrypt(keyB64, "wx999", encrypted); err == nil {
		t.Fatal("wrong appid must fail")
	}
	// A wrong key must fail (padding or length check).
	other := wxaTestKeyB64(t) + "A" // differ, still decodable after '=' strip
	if _, err := wxaDecrypt(other[:40]+"BBB", "wx123", encrypted); err == nil {
		t.Fatal("wrong key must fail")
	}
	if _, err := wxaDecrypt(keyB64, "wx123", "not-base64!"); err == nil {
		t.Fatal("bad base64 must fail")
	}
}

func TestParseWXAPushFormats(t *testing.T) {
	jsonBody := []byte(`{"Event":"wxa_media_check","trace_id":"t2","result":{"suggest":"review"}}`)
	push, err := parseWXAPush(jsonBody)
	if err != nil || push.Event != "wxa_media_check" || push.TraceID != "t2" || push.Result.Suggest != "review" {
		t.Fatalf("json parse: %v %+v", err, push)
	}
	xmlBody := []byte(`<xml><Event><![CDATA[wxa_media_check]]></Event><trace_id>t3</trace_id><result><suggest>risky</suggest></result></xml>`)
	push, err = parseWXAPush(xmlBody)
	if err != nil || push.TraceID != "t3" || push.Result.Suggest != "risky" {
		t.Fatalf("xml parse: %v %+v", err, push)
	}
	// The safe-mode envelope carries Encrypt; the parser must expose it.
	envelope := []byte(`{"Encrypt":"abc","Event":"invalid"}`)
	if push, err = parseWXAPush(envelope); err != nil || push.Encrypt != "abc" {
		t.Fatalf("envelope parse: %v %+v", err, push)
	}
}
