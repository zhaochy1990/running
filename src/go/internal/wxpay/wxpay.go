// Package wxpay wraps the official WeChat Pay APIv3 SDK
// (github.com/wechatpay-apiv3/wechatpay-go) for the points-shop shipping-fee
// checkout (devops#904): JSAPI prepay that returns the exact five-parameter
// payload the miniprogram feeds wx.requestPayment, payment-notify handling
// (platform-certificate signature verification + AEAD_AES_256_GCM decryption
// via the SDK's notify.Handler), and order close for the timeout sweep.
//
// The module is inert until fully configured: an empty credential field keeps
// the client unconstructed, the redeem gate answers 503 payment_unavailable
// for fee-charged products, and zero-fee goods are unaffected.
package wxpay

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/wechatpay-apiv3/wechatpay-go/core"
	"github.com/wechatpay-apiv3/wechatpay-go/core/auth/verifiers"
	"github.com/wechatpay-apiv3/wechatpay-go/core/downloader"
	"github.com/wechatpay-apiv3/wechatpay-go/core/notify"
	"github.com/wechatpay-apiv3/wechatpay-go/core/option"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments/jsapi"
	"github.com/wechatpay-apiv3/wechatpay-go/utils"
)

// TradeStateSuccess is the payments.Transaction trade_state that moves an
// order pending → paid; every other state is a no-op for the state machine.
const TradeStateSuccess = "SUCCESS"

// Config carries the merchant credentials injected via env (devops#904).
// Every field is required for a live client; Configured reports whether the
// deployment supplied them all.
type Config struct {
	// AppID is the miniprogram's appid — the JSAPI prepay payer context and
	// the first line of the wx.requestPayment paySign message.
	AppID string
	// MchID is the WeChat Pay merchant id.
	MchID string
	// MerchantSerialNo is the merchant API certificate serial number.
	MerchantSerialNo string
	// PrivateKeyPEM is the merchant API certificate private key, PEM text.
	PrivateKeyPEM string
	// APIv3Key decrypts the AEAD_AES_256_GCM callback payloads.
	APIv3Key string
	// NotifyURL is the absolute https callback endpoint
	// (POST /api/wxpay/notify); no query string allowed.
	NotifyURL string
}

// Configured reports whether every credential field is non-empty.
func (c Config) Configured() bool {
	return c.AppID != "" && c.MchID != "" && c.MerchantSerialNo != "" &&
		c.PrivateKeyPEM != "" && c.APIv3Key != "" && c.NotifyURL != ""
}

// PaymentParams is exactly what the miniprogram passes to wx.requestPayment
// to collect the shipping fee (devops#904 five-parameter contract).
type PaymentParams struct {
	TimeStamp string `json:"timeStamp"`
	NonceStr  string `json:"nonceStr"`
	Package   string `json:"package"`
	SignType  string `json:"signType"`
	PaySign   string `json:"paySign"`
}

// NotifyPayment is the verified, decrypted payment result a callback carries.
type NotifyPayment struct {
	OutTradeNo string
	TradeState string
	// PaidFen is the order total in fen (transaction.amount.total) — the
	// amount the merchant order must match before the paid transition runs.
	PaidFen int64
}

// Client fronts the SDK for the shipping-fee flow. Construction registers the
// platform-certificate downloader (auto rotation), so New needs network access
// to api.mch.weixin.qq.com and fails fast when it cannot establish trust —
// credentials that cannot verify callbacks must not serve prepay either.
type Client struct {
	cfg    Config
	jsapi  *jsapi.JsapiApiService
	notify *notify.Handler
}

// New builds a live client from merchant credentials.
func New(ctx context.Context, cfg Config) (*Client, error) {
	if !cfg.Configured() {
		return nil, errors.New("wxpay: config incomplete")
	}
	key, err := utils.LoadPrivateKey(cfg.PrivateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("wxpay: parse merchant private key: %w", err)
	}
	// One client covers request signing / response verification / sensitive
	// field crypto AND registers the platform-cert downloader behind it; the
	// notify handler then shares the downloader's certificate visitor.
	client, err := core.NewClient(ctx,
		option.WithWechatPayAutoAuthCipher(cfg.MchID, cfg.MerchantSerialNo, key, cfg.APIv3Key),
	)
	if err != nil {
		return nil, fmt.Errorf("wxpay: build api client: %w", err)
	}
	certVisitor := downloader.MgrInstance().GetCertificateVisitor(cfg.MchID)
	handler, err := notify.NewRSANotifyHandler(cfg.APIv3Key, verifiers.NewSHA256WithRSAVerifier(certVisitor))
	if err != nil {
		return nil, fmt.Errorf("wxpay: build notify handler: %w", err)
	}
	return &Client{
		cfg:    cfg,
		jsapi:  &jsapi.JsapiApiService{Client: client}, //nolint: revive // generated API naming
		notify: handler,
	}, nil
}

// Configured reports whether the client holds live credentials (false = the
// module is inert; the API must not mount payment surfaces off it).
func (c *Client) Configured() bool { return c != nil && c.cfg.Configured() }

// PrepayPaymentParams runs the JSAPI prepay for one shipping fee and returns
// the wx.requestPayment parameters. outTradeNo is the redemption order id;
// feeFen is the order's shipping_fee_snapshot in fen; description follows the
// WeChat contract (the shop shows it on the payment sheet).
func (c *Client) PrepayPaymentParams(ctx context.Context, outTradeNo, description string, feeFen int64, openid string) (*PaymentParams, error) {
	if !c.Configured() {
		return nil, errors.New("wxpay: client is not configured")
	}
	resp, _, err := c.jsapi.PrepayWithRequestPayment(ctx, jsapi.PrepayRequest{
		Appid:       core.String(c.cfg.AppID),
		Mchid:       core.String(c.cfg.MchID),
		Description: core.String(description),
		OutTradeNo:  core.String(outTradeNo),
		NotifyUrl:   core.String(c.cfg.NotifyURL),
		Amount:      &jsapi.Amount{Total: core.Int64(feeFen)},
		Payer:       &jsapi.Payer{Openid: core.String(openid)},
	})
	if err != nil {
		return nil, fmt.Errorf("wxpay: jsapi prepay: %w", err)
	}
	return &PaymentParams{
		TimeStamp: deref(resp.TimeStamp),
		NonceStr:  deref(resp.NonceStr),
		Package:   deref(resp.Package),
		SignType:  deref(resp.SignType),
		PaySign:   deref(resp.PaySign),
	}, nil
}

// deref reads one SDK response string pointer (nil-safe; the SDK sets every
// field of PrepayWithRequestPaymentResponse on success, but a nil read must
// not panic the API process).
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// CloseOrder closes one order upstream so a timed-out order can no longer be
// paid. Codes that mean the order was never payable again — nonexistent
// (the user never reached prepay) or already closed (a previous sweep died
// between close and refund) — are treated as success so the refund proceeds;
// anything else (transient failures, an already-paid order) is an error and
// the caller must leave the order for the next sweep.
func (c *Client) CloseOrder(ctx context.Context, outTradeNo string) error {
	if !c.Configured() {
		return errors.New("wxpay: client is not configured")
	}
	_, err := c.jsapi.CloseOrder(ctx, jsapi.CloseOrderRequest{
		Mchid:      core.String(c.cfg.MchID),
		OutTradeNo: core.String(outTradeNo),
	})
	return closeErrClassify(err)
}

// closeErrClassify collapses the WeChat close-order outcomes that mean the
// order was already unpayable into nil so the sweep can refund; everything
// else (transient failures, an already-paid order) stays an error.
func closeErrClassify(err error) error {
	if err == nil {
		return nil
	}
	var apiErr *core.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Code {
		case "ORDER_NOT_EXIST", "ORDER_CLOSED":
			return nil
		}
	}
	return fmt.Errorf("wxpay: close order: %w", err)
}

// ParseNotify verifies the callback's platform signature and decrypts its
// AEAD_AES_256_GCM resource into NotifyPayment. A verification or decryption
// failure is an error — the endpoint must answer non-success so WeChat does
// not treat the notification as delivered.
func (c *Client) ParseNotify(ctx context.Context, r *http.Request) (*NotifyPayment, error) {
	if !c.Configured() {
		return nil, errors.New("wxpay: client is not configured")
	}
	var tx payments.Transaction
	if _, err := c.notify.ParseNotifyRequest(ctx, r, &tx); err != nil {
		return nil, fmt.Errorf("wxpay: verify/decrypt notify: %w", err)
	}
	out := &NotifyPayment{}
	if tx.OutTradeNo != nil {
		out.OutTradeNo = *tx.OutTradeNo
	}
	if tx.TradeState != nil {
		out.TradeState = *tx.TradeState
	}
	if tx.Amount != nil && tx.Amount.Total != nil {
		out.PaidFen = *tx.Amount.Total
	}
	return out, nil
}
