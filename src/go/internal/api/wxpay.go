// wxpay.go is the WeChat Pay surface for the shipping-fee checkout
// (devops#904). Two mounts, opposite trust models:
//
//	User:   POST /api/users/me/points/redemptions/:id/pay  (default-deny group;
//	        JSAPI prepay for one pending order, answers the five-parameter
//	        payload wx.requestPayment needs)
//	Public: POST /api/wxpay/notify  (bare engine, no JWT — the caller is
//	        WeChat Pay's server; the WeChat Pay public-key signature
//	        verification + AEAD_AES_256_GCM decryption replace authentication,
//	        same pattern as the watch-provider webhook ingress)
//
// The notify handler is idempotent by the storage transition it drives: the
// guarded pending → paid UPDATE runs once, and every replay — or any
// notification for an already-paid or already-cancelled order — answers 200
// with no state change.
package api

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/wxpay"
)

// WxPayGateway is the payment-module port the API consumes, satisfied by
// *wxpay.Client. Nil means the module is inert: the pay endpoint and the
// notify route stay unmounted and a fee-charged redemption answers 503
// payment_unavailable.
type WxPayGateway interface {
	Configured() bool
	PrepayPaymentParams(ctx context.Context, outTradeNo, description string, feeFen int64, openid string) (*wxpay.PaymentParams, error)
	ParseNotify(ctx context.Context, r *http.Request) (*wxpay.NotifyPayment, error)
}

// WxPayStore is the persistence the pay + notify handlers need.
type WxPayStore interface {
	// GetUserRedemption reads one of the caller's own orders.
	GetUserRedemption(ctx context.Context, userID, id string) (*storage.PointRedemption, error)
	// GetRedemptionByOutTradeNo reads one order by its WeChat trade number
	// (the only handle a callback carries). A miss returns (nil, nil).
	GetRedemptionByOutTradeNo(ctx context.Context, outTradeNo string) (*storage.PointRedemption, error)
	// MarkRedemptionPaid applies the one-way pending → paid transition.
	MarkRedemptionPaid(ctx context.Context, outTradeNo string, paidAt time.Time) (bool, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type wxpayRoutes struct {
	store WxPayStore
	pay   WxPayGateway
	log   *zap.Logger
}

// wxpayReady guards the module gate: a nil gateway (or a configured-empty
// client) keeps the module inert, exactly per devops#904.
func wxpayReady(p WxPayGateway) bool {
	return p != nil && p.Configured()
}

func newWxPayRoutes(store WxPayStore, pay WxPayGateway, log *zap.Logger) *wxpayRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &wxpayRoutes{store: store, pay: pay, log: log}
}

// registerUser mounts POST /api/users/me/points/redemptions/:id/pay on the
// default-deny group. Nothing mounts when the module is inert or the store is
// absent (tests running a partial service).
func (w *wxpayRoutes) registerUser(rg *gin.RouterGroup) {
	if w.store == nil || !wxpayReady(w.pay) {
		return
	}
	rg.POST("/api/users/me/points/redemptions/:id/pay", w.prepay)
}

// registerNotify mounts POST /api/wxpay/notify on the bare engine: public,
// body-capped, verified by WeChat's platform signature instead of a JWT tier
// (the webhook ingress pattern). Nothing mounts when the module is inert.
func (w *wxpayRoutes) registerNotify(r *gin.Engine) {
	if w.store == nil || !wxpayReady(w.pay) {
		return
	}
	g := r.Group("", limitBody(maxRequestBytes))
	g.POST("/api/wxpay/notify", w.notify)
}

// ─────────────────────────────────────────────────────────────────────────────
// User handler: JSAPI prepay
// ─────────────────────────────────────────────────────────────────────────────

// wxpayPrepayRequest is the POST pay body: the caller's JSAPI openid, from
// the miniprogram's own wx.login context (the auth service owns the binding;
// the pay sheet needs it fresh, never stored here).
type wxpayPrepayRequest struct {
	OpenID string `json:"openid" binding:"required,max=64"`
}

// wxpayPrepayResponse carries exactly the five parameters wx.requestPayment
// takes (devops#904 wire contract with the miniprogram).
type wxpayPrepayResponse struct {
	TimeStamp string `json:"timeStamp"`
	NonceStr  string `json:"nonceStr"`
	Package   string `json:"package"`
	SignType  string `json:"signType"`
	PaySign   string `json:"paySign"`
}

// prepay serves POST /api/users/me/points/redemptions/:id/pay — JSAPI prepay
// for one of the caller's own pending orders: out_trade_no = the order id
// derived through wxpay.OutTradeNoFromOrderID (WeChat's 6-32 limit; the
// stored column is never read, so hyphen-legacy rows prepay the same number
// the notify will echo), amount = the redeem-time shipping_fee_snapshot in
// fen, description = product name + shipping-fee suffix, notify_url from env.
//
//	@Summary		Pay a redemption order's shipping fee
//	@Description	Starts WeChat Pay JSAPI for one pending_payment order (shipping fee in fen) and returns the five parameters wx.requestPayment needs: timeStamp, nonceStr, package, signType, paySign.
//	@Tags			points
//	@Accept			json
//	@Produce		json
//	@Param			id		path	string				true	"Order id"
//	@Param			body	body	wxpayPrepayRequest	true	"JSAPI payer"
//	@Success		200		{object}	wxpayPrepayResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		502		{object}	errorResponse
//	@Failure		503		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/points/redemptions/{id}/pay [post]
func (w *wxpayRoutes) prepay(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var body wxpayPrepayRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	order, err := w.store.GetUserRedemption(c.Request.Context(), uid, c.Param("id"))
	if err != nil {
		writeRedemptionError(c, w.log, err) // 404 redemption_not_found
		return
	}
	// Only a parked fee order can pay, and the gate is the STATUS, not the
	// payment state: a swept (cancelled) order keeps payment_state=pending,
	// so a payment_state check alone would let a dead order collect money.
	// Zero-fee orders are payment_state=free (already pending_shipment) and
	// paid orders are past the gate either way.
	if order.Status != storage.RedemptionStatusPendingPayment {
		c.JSON(http.StatusConflict, errorResponse{Error: "payment_not_pending"})
		return
	}
	params, err := w.pay.PrepayPaymentParams(
		c.Request.Context(), wxpay.OutTradeNoFromOrderID(order.ID),
		order.ProductName+"·运费", int64(order.ShippingFeeSnapshot), body.OpenID,
	)
	if err != nil {
		w.log.Error("wxpay jsapi prepay failed", zapErr(err))
		c.JSON(http.StatusBadGateway, errorResponse{Error: "wxpay_upstream_error"})
		return
	}
	c.JSON(http.StatusOK, wxpayPrepayResponse{
		TimeStamp: params.TimeStamp, NonceStr: params.NonceStr,
		Package: params.Package, SignType: params.SignType, PaySign: params.PaySign,
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Public handler: payment result notify
// ─────────────────────────────────────────────────────────────────────────────

// wxpayNotifyResult is the response envelope WeChat Pay's server reads: code
// SUCCESS acknowledges delivery, FAIL (with a 4xx/5xx status) asks it to
// retry — 4xx for failures retrying cannot fix, 5xx for ones it should.
type wxpayNotifyResult struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (w *wxpayRoutes) ack(c *gin.Context) {
	c.JSON(http.StatusOK, wxpayNotifyResult{Code: "SUCCESS", Message: "成功"})
}

func (w *wxpayRoutes) fail(c *gin.Context, status int, message string) {
	c.JSON(status, wxpayNotifyResult{Code: "FAIL", Message: message})
}

// notify serves POST /api/wxpay/notify — verify the platform signature,
// decrypt the AEAD payload, then move the named order pending → paid exactly
// once. A signed SUCCESS notification whose amount disagrees with the order's
// shipping_fee_snapshot is refused with FAIL (retryable): money correctness
// beats retry noise.
func (w *wxpayRoutes) notify(c *gin.Context) {
	payment, err := w.pay.ParseNotify(c.Request.Context(), c.Request)
	if err != nil {
		w.log.Warn("wxpay notify failed verification",
			zap.String("serial", c.GetHeader("Wechatpay-Serial")), zapErr(err))
		w.fail(c, http.StatusUnauthorized, "签名验证失败") // 4xx: never re-delivered
		return
	}
	order, err := w.store.GetRedemptionByOutTradeNo(c.Request.Context(), payment.OutTradeNo)
	if err != nil {
		w.log.Error("wxpay notify order lookup failed", zapErr(err))
		w.fail(c, http.StatusInternalServerError, "订单查询失败")
		return
	}
	if order == nil {
		w.log.Warn("wxpay notify for unknown out_trade_no", zap.String("out_trade_no", payment.OutTradeNo))
		w.ack(c) // nothing to transition; acknowledging stops the retries
		return
	}
	// Non-SUCCESS states (CLOSED, PAYERROR, …) carry no state change for us.
	if payment.TradeState != wxpay.TradeStateSuccess {
		w.ack(c)
		return
	}
	if payment.PaidFen != int64(order.ShippingFeeSnapshot) {
		w.log.Error("wxpay notify amount mismatch",
			zap.String("out_trade_no", payment.OutTradeNo),
			zap.Int64("paid_fen", payment.PaidFen),
			zap.Int("order_fen", order.ShippingFeeSnapshot))
		w.fail(c, http.StatusInternalServerError, "金额不一致")
		return
	}
	transitioned, err := w.store.MarkRedemptionPaid(c.Request.Context(), payment.OutTradeNo, time.Now().UTC())
	if err != nil {
		w.log.Error("wxpay notify paid transition failed", zapErr(err))
		w.fail(c, http.StatusInternalServerError, "状态更新失败")
		return
	}
	if transitioned {
		w.log.Info("wxpay notify paid",
			zap.String("out_trade_no", payment.OutTradeNo), zap.String("order_id", order.ID))
	}
	// First notification and every replay land here: 200 no-op (devops#904
	// idempotency contract).
	w.ack(c)
}
