// points.go is the points-shop + redemption surface (devops#884; contract per
// devops#850 resolution, upload per devops#896, SKU per devops#909): the
// user-side product list, redeem call and order list, plus the admin blocks —
// product maintenance (GET/POST/PATCH, deliberately no DELETE: products
// delist via status=inactive; drafts start hidden) with its image upload and
// its SKU-row CRUD, order shipping (list + terminal ship), and the user
// balances surface (list, adjust, per-user ledger; devops#914, handlers in
// points_admin.go).
//
//	User:  GET   /api/users/me/points/products     (active only + own redeemed_count)
//	       POST  /api/users/me/points/redemptions  {product_id, address_id, idempotency_key, sku_id?}
//	       GET   /api/users/me/points/redemptions  (?limit&cursor)
//	Admin: GET   /api/admin/points/products        (全量含 draft/inactive)
//	       POST  /api/admin/points/products        (status 缺省 draft)
//	       POST  /api/admin/points/product-images  (multipart, ≤10MB, image/*; bare engine)
//	       PATCH /api/admin/points/products/:id    (改价/改库存=绝对值; no DELETE)
//	       POST  /api/admin/points/products/:id/skus          (by_sku 行)
//	       PATCH /api/admin/points/products/:id/skus/:sku_id  (改库存=绝对值)
//	       DELETE /api/admin/points/products/:id/skus/:sku_id
//	       GET   /api/admin/points/redemptions     (?status=&limit&cursor)
//	       PATCH /api/admin/points/redemptions/:id/ship {tracking_no}
//	       GET   /api/admin/points/balances        (?sort=&user_id=&phone=&limit&cursor)
//	       POST  /api/admin/points/balances/:user_id/adjustments {amount, reason}
//	       GET   /api/admin/points/balances/:user_id/transactions (?limit&cursor)
package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// PointsStore is the redemption persistence port (devops#884). Satisfied by
// *storage.Store.
type PointsStore interface {
	ListActiveProducts(ctx context.Context, userID string) ([]storage.PointProductListing, error)
	CreateRedemption(ctx context.Context, userID string, req storage.RedemptionRequest) (*storage.RedemptionResult, error)
	ListUserRedemptions(ctx context.Context, userID, cursor string, limit int) (*storage.RedemptionPage, error)
	ListPointTransactions(ctx context.Context, userID, cursor string, limit int) (*storage.PointPage, error)
	AdminListProducts(ctx context.Context) ([]storage.PointProductListing, error)
	AdminCreateProduct(ctx context.Context, row *storage.PointProduct) error
	AdminPatchProduct(ctx context.Context, id uint64, patch storage.ProductPatch) (*storage.PointProduct, error)
	AdminCreateProductSku(ctx context.Context, productID uint64, row *storage.PointProductSku) error
	AdminPatchProductSku(ctx context.Context, productID, skuID uint64, patch storage.SkuPatch) (*storage.PointProductSku, error)
	AdminDeleteProductSku(ctx context.Context, productID, skuID uint64) error
	AdminListRedemptions(ctx context.Context, status, cursor string, limit int) (*storage.AdminRedemptionPage, error)
	AdminShipRedemption(ctx context.Context, id, courierCompany, trackingNo string, now time.Time) (*storage.PointRedemption, error)
	AdminListPointBalances(ctx context.Context, sort, cursor string, limit int, userID string, phoneIDs []string) (*storage.AdminPointBalancePage, error)
	AdminAdjustPointBalance(ctx context.Context, userID string, amount int, reason string, now time.Time) (*storage.PointAdjustmentResult, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type pointsRoutes struct {
	store  PointsStore
	images FeedbackImages
	// pay is the WeChat Pay module gate (devops#904): nil (module inert) makes
	// a fee-charged redemption answer 503 payment_unavailable; zero-fee goods
	// never consult it.
	pay WxPayGateway
	// auth resolves admin-surface user names and phone matches through the
	// auth service (devops#914). Nil (deployment without auth service)
	// degrades list names to raw ids and answers phone search with 503.
	auth authUserLookup
	log  *zap.Logger
}

func newPointsRoutes(store PointsStore, images FeedbackImages, pay WxPayGateway, auth authUserLookup, log *zap.Logger) *pointsRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &pointsRoutes{store: store, images: images, pay: pay, auth: auth, log: log}
}

// registerUser mounts the user-tier surface on the default-deny group (the
// admin tier has its own surface below).
func (p *pointsRoutes) registerUser(rg *gin.RouterGroup) {
	if p.store == nil {
		return
	}
	rg.GET("/api/users/me/points/products", p.listProducts)
	rg.POST("/api/users/me/points/redemptions", p.createRedemption)
	rg.GET("/api/users/me/points/redemptions", p.listRedemptions)
}

// registerAdmin mounts the administrator surface on the parent authenticated
// group; every handler re-checks TierAdmin (same pattern as the roadmap admin
// tab).
func (p *pointsRoutes) registerAdmin(rg *gin.RouterGroup) {
	if p.store == nil {
		return
	}
	rg.GET("/api/admin/points/products", p.adminListProducts)
	rg.POST("/api/admin/points/products", p.adminCreateProduct)
	rg.PATCH("/api/admin/points/products/:id", p.adminPatchProduct)
	rg.POST("/api/admin/points/products/:id/skus", p.adminCreateProductSku)
	rg.PATCH("/api/admin/points/products/:id/skus/:sku_id", p.adminPatchProductSku)
	rg.DELETE("/api/admin/points/products/:id/skus/:sku_id", p.adminDeleteProductSku)
	rg.GET("/api/admin/points/redemptions", p.adminListRedemptions)
	rg.PATCH("/api/admin/points/redemptions/:id/ship", p.adminShipRedemption)
	// User balances surface (devops#914), handlers in points_admin.go.
	rg.GET("/api/admin/points/balances", p.adminListBalances)
	rg.POST("/api/admin/points/balances/:user_id/adjustments", p.adminAdjustBalance)
	rg.GET("/api/admin/points/balances/:user_id/transactions", p.adminListUserTransactions)
}

// registerUpload mounts POST /api/admin/points/product-images on the bare
// engine (devops#896): the shared authenticated group caps bodies at 1 MiB,
// far below the 10MB image contract, so this route carries its own chain
// (bigger body cap → auth → admin-tier guard). The handler still re-checks
// requireAdmin, mirroring the feedback upload's mount. The size constants are
// the feedback upload's — same contract, one source of truth.
func (p *pointsRoutes) registerUpload(r *gin.Engine, auth *Authenticator) {
	if p.store == nil {
		return
	}
	r.POST("/api/admin/points/product-images", limitBody(maxFeedbackUploadBody), auth.middleware(), rejectNonAdminCaller, p.upload)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// productResponse is one shop card: the stored fields (shipping policy and
// fee included since devops#904, spec mode + SKU rows since devops#909) plus
// the caller's own redeemed count (the UI grays out limit-reached cards with
// it). stock is display-only for by_sku products — the SKU sum, feeding the
// card's sold-out hint; the redemption never reads it.
type productResponse struct {
	ID             uint64        `json:"id"`
	Name           string        `json:"name"`
	Description    *string       `json:"description"`
	ImageURL       *string       `json:"image_url"`
	PointsPrice    int           `json:"points_price"`
	Stock          int           `json:"stock"`
	PerUserLimit   int           `json:"per_user_limit"`
	SpecMode       string        `json:"spec_mode"`
	Skus           []skuResponse `json:"skus,omitempty"`
	ShippingPolicy string        `json:"shipping_policy"`
	ShippingFee    int           `json:"shipping_fee"`
	RedeemedCount  int           `json:"redeemed_count"`
}

// skuResponse is one variant row of a by_sku card (devops#909): exactly the
// three fields the size picker needs — pick a码, grey out zero stock.
type skuResponse struct {
	ID        uint64 `json:"id"`
	SpecValue string `json:"spec_value"`
	Stock     int    `json:"stock"`
}

type productsResponse struct {
	Products []productResponse `json:"products"`
}

// redemptionResponse is one order. The receiver block is the redeem-time
// snapshot; status walks pending_payment → pending_shipment → shipped
// (terminal) for fee-charged orders, pending_shipment → shipped for zero-fee
// ones, with cancelled as the timeout-sweep terminal (devops#904). The
// payment block (fee/policy snapshots, payment_state, paid_at) is the same
// redeem-time commit as the points deduction. sku_label (devops#909) is the
// bought variant's snapshot; NULL (omitted) for single-mode and pre-#909
// orders, which render「无尺码」.
type redemptionResponse struct {
	ID                     string  `json:"id"`
	ProductID              uint64  `json:"product_id"`
	ProductName            string  `json:"product_name"`
	PointsCost             int     `json:"points_cost"`
	Quantity               int     `json:"quantity"`
	SkuLabel               *string `json:"sku_label"`
	Status                 string  `json:"status"`
	CourierCompany         *string `json:"courier_company"`
	TrackingNo             *string `json:"tracking_no"`
	ShippedAt              *string `json:"shipped_at"`
	ShippingFeeSnapshot    int     `json:"shipping_fee_snapshot"`
	ShippingPolicySnapshot string  `json:"shipping_policy_snapshot"`
	PaymentState           string  `json:"payment_state"`
	PaidAt                 *string `json:"paid_at"`
	ReceiverName           string  `json:"receiver_name"`
	ReceiverPhone          string  `json:"receiver_phone"`
	Province               string  `json:"province"`
	City                   string  `json:"city"`
	District               string  `json:"district"`
	AddressDetail          string  `json:"address_detail"`
	CreatedAt              string  `json:"created_at"`
}

type redemptionsResponse struct {
	Redemptions []redemptionResponse `json:"redemptions"`
	NextCursor  *string              `json:"next_cursor"`
}

// redemptionCreateResponse is the POST body: the created (or idempotently
// replayed) order plus the post-redeem balance.
type redemptionCreateResponse struct {
	Order    redemptionResponse `json:"order"`
	Balance  int                `json:"balance"`
	Replayed bool               `json:"replayed"`
}

// adminProductResponse is the admin projection: every stored field, plus the
// SKU rows on by_sku products (devops#909; stock there is the SKU sum,
// display only).
type adminProductResponse struct {
	ID             uint64        `json:"id"`
	Name           string        `json:"name"`
	Description    *string       `json:"description"`
	ImageURL       *string       `json:"image_url"`
	PointsPrice    int           `json:"points_price"`
	Stock          int           `json:"stock"`
	PerUserLimit   int           `json:"per_user_limit"`
	SpecMode       string        `json:"spec_mode"`
	Skus           []skuResponse `json:"skus,omitempty"`
	ShippingPolicy string        `json:"shipping_policy"`
	ShippingFee    int           `json:"shipping_fee"`
	Status         string        `json:"status"`
	SortOrder      int           `json:"sort_order"`
	CreatedAt      string        `json:"created_at"`
	UpdatedAt      string        `json:"updated_at"`
}

type adminProductsResponse struct {
	Products []adminProductResponse `json:"products"`
}

// adminRedemptionResponse adds the owner to the user projection — the admin
// list answers "whose order is this".
type adminRedemptionResponse struct {
	redemptionResponse
	UserID string `json:"user_id"`
}

type adminRedemptionsResponse struct {
	Redemptions []adminRedemptionResponse `json:"redemptions"`
	NextCursor  *string                   `json:"next_cursor"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

func formatOptionalTime(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(timeFormat)
	return &s
}

func redemptionDTO(r *storage.PointRedemption) redemptionResponse {
	return redemptionResponse{
		ID: r.ID, ProductID: r.ProductID, ProductName: r.ProductName,
		PointsCost: r.PointsCost, Quantity: r.Quantity, SkuLabel: r.SkuLabel,
		Status:         r.Status,
		CourierCompany: r.CourierCompany,
		TrackingNo:     r.TrackingNo, ShippedAt: formatOptionalTime(r.ShippedAt),
		ShippingFeeSnapshot:    r.ShippingFeeSnapshot,
		ShippingPolicySnapshot: r.ShippingPolicySnapshot,
		PaymentState:           r.PaymentState,
		PaidAt:                 formatOptionalTime(r.PaidAt),
		ReceiverName:           r.ReceiverName, ReceiverPhone: r.ReceiverPhone,
		Province: r.Province, City: r.City, District: r.District,
		AddressDetail: r.AddressDetail,
		CreatedAt:     r.CreatedAt.UTC().Format(timeFormat),
	}
}

// skuDTO is the admin SKU projection: the full stored row.
type adminSkuResponse struct {
	ID        uint64 `json:"id"`
	ProductID uint64 `json:"product_id"`
	SpecValue string `json:"spec_value"`
	Stock     int    `json:"stock"`
	SortOrder int    `json:"sort_order"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func adminSkuDTO(s *storage.PointProductSku) adminSkuResponse {
	return adminSkuResponse{
		ID: s.ID, ProductID: s.ProductID, SpecValue: s.SpecValue,
		Stock: s.Stock, SortOrder: s.SortOrder,
		CreatedAt: s.CreatedAt.UTC().Format(timeFormat),
		UpdatedAt: s.UpdatedAt.UTC().Format(timeFormat),
	}
}

// skuResponses projects a listing's SKU rows onto the card shape. by_sku
// products always carry an array (empty when the admin has not configured
// any row yet); single products carry no field at all, keeping their
// pre-#909 wire shape.
func skuResponses(l *storage.PointProductListing) []skuResponse {
	if l.Product.SpecMode != storage.ProductSpecModeBySku {
		return nil
	}
	out := make([]skuResponse, 0, len(l.Skus))
	for i := range l.Skus {
		out = append(out, skuResponse{ID: l.Skus[i].ID, SpecValue: l.Skus[i].SpecValue, Stock: l.Skus[i].Stock})
	}
	return out
}

// displayStock is the product-level stock the lists show: the stored column
// for single products, the SKU sum for by_sku ones (devops#909 — display
// only, the redemption reads the SKU rows themselves).
func displayStock(l *storage.PointProductListing) int {
	if l.Product.SpecMode != storage.ProductSpecModeBySku {
		return l.Product.Stock
	}
	total := 0
	for i := range l.Skus {
		total += l.Skus[i].Stock
	}
	return total
}

func adminProductDTO(p *storage.PointProductListing) adminProductResponse {
	return adminProductResponse{
		ID: p.Product.ID, Name: p.Product.Name, Description: p.Product.Description, ImageURL: p.Product.ImageURL,
		PointsPrice: p.Product.PointsPrice, Stock: displayStock(p), PerUserLimit: p.Product.PerUserLimit,
		SpecMode: p.Product.SpecMode, Skus: skuResponses(p),
		ShippingPolicy: p.Product.ShippingPolicy, ShippingFee: p.Product.ShippingFee,
		Status: p.Product.Status, SortOrder: p.Product.SortOrder,
		CreatedAt: p.Product.CreatedAt.UTC().Format(timeFormat),
		UpdatedAt: p.Product.UpdatedAt.UTC().Format(timeFormat),
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// User handlers
// ─────────────────────────────────────────────────────────────────────────────

// listProducts serves GET /api/users/me/points/products — the active shop,
// sort_order ASC, each card carrying the caller's own redeemed count, the
// spec mode and, for by_sku products, the SKU rows (devops#909).
//
//	@Summary		List the points shop
//	@Description	Returns the active products (sort_order ASC) with the caller's own redeemed count per product. Inactive products never appear. by_sku products carry their skus array and stock = the SKU sum (display only).
//	@Tags			points
//	@Produce		json
//	@Success		200	{object}	productsResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/points/products [get]
func (p *pointsRoutes) listProducts(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	rows, err := p.store.ListActiveProducts(c.Request.Context(), uid)
	if err != nil {
		p.log.Error("list active products failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	resp := productsResponse{Products: make([]productResponse, 0, len(rows))}
	for i := range rows {
		resp.Products = append(resp.Products, productResponse{
			ID: rows[i].Product.ID, Name: rows[i].Product.Name,
			Description: rows[i].Product.Description, ImageURL: rows[i].Product.ImageURL,
			PointsPrice: rows[i].Product.PointsPrice, Stock: displayStock(&rows[i]),
			PerUserLimit:   rows[i].Product.PerUserLimit,
			SpecMode:       rows[i].Product.SpecMode,
			Skus:           skuResponses(&rows[i]),
			ShippingPolicy: rows[i].Product.ShippingPolicy, ShippingFee: rows[i].Product.ShippingFee,
			RedeemedCount: rows[i].RedeemedCount,
		})
	}
	c.JSON(http.StatusOK, resp)
}

// redemptionCreateRequest is the POST body; idempotency_key is the client's
// double-click/retry anchor (one key = one order). quantity is optional —
// omitted/zero resolves to 1 server-side (legacy clients stay wire-compatible);
// cost = product price × quantity. sku_id is optional (devops#909): required
// for by_sku products (409 sku_required otherwise), rejected on single ones.
type redemptionCreateRequest struct {
	ProductID      uint64 `json:"product_id" binding:"required"`
	AddressID      uint64 `json:"address_id" binding:"required"`
	IdempotencyKey string `json:"idempotency_key" binding:"required,max=64"`
	Quantity       int    `json:"quantity" binding:"omitempty,min=1,max=99"`
	SkuID          uint64 `json:"sku_id"`
}

// createRedemption serves POST /api/users/me/points/redemptions — the single
// transaction redeem (#850 authoritative order). Business rejections map onto
// their stable codes (404 address_not_found; 409 product_inactive /
// out_of_stock / limit_reached / insufficient_points / sku_required /
// sku_invalid); a replayed idempotency_key returns the stored order with 200.
//
//	@Summary		Redeem a product with points
//	@Description	Runs the redemption transaction: idempotency replay check, guarded stock decrement (by quantity — the SKU row for by_sku products), per-user limit sum (in units, product-level), guarded points deduction (price × quantity), then order + ledger rows in one commit. quantity is optional (1-99, default 1); sku_id is required for by_sku products. Repeating an idempotency_key returns the stored order with zero side effects.
//	@Tags			points
//	@Accept			json
//	@Produce		json
//	@Param			body	body	redemptionCreateRequest	true	"Redeem request"
//	@Success		200		{object}	redemptionCreateResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/points/redemptions [post]
func (p *pointsRoutes) createRedemption(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var body redemptionCreateRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	// binding:"required" rejects zero values, and a zero uint64 is never a
	// real product/address id (parseUintParam enforces the same floor).
	req := storage.RedemptionRequest{
		ProductID:      body.ProductID,
		AddressID:      body.AddressID,
		IdempotencyKey: body.IdempotencyKey,
		Quantity:       body.Quantity,
		PaymentReady:   wxpayReady(p.pay),
		SkuID:          body.SkuID,
	}
	res, err := p.store.CreateRedemption(c.Request.Context(), uid, req)
	if err != nil {
		writeRedemptionError(c, p.log, err)
		return
	}
	c.JSON(http.StatusOK, redemptionCreateResponse{
		Order: redemptionDTO(res.Order), Balance: res.Balance, Replayed: res.Replayed,
	})
}

// listRedemptions serves GET /api/users/me/points/redemptions?limit&cursor —
// the caller's orders newest-first with keyset cursor pagination.
//
//	@Summary		List my redemption orders
//	@Description	Returns the caller's orders newest-first (receiver snapshot included) with an opaque next_cursor.
//	@Tags			points
//	@Produce		json
//	@Param			limit	query	int		false	"Page size (1-50; default 50)"
//	@Param			cursor	query	string	false	"Opaque page cursor"
//	@Success		200	{object}	redemptionsResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		422	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/points/redemptions [get]
func (p *pointsRoutes) listRedemptions(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	limit, ok := parseLimitQuery(c)
	if !ok {
		return
	}
	page, err := p.store.ListUserRedemptions(c.Request.Context(), uid, c.Query("cursor"), limit)
	if err != nil {
		var cursorErr *storage.PointCursorError
		var validationErr *storage.PointValidationError
		switch {
		case errors.As(err, &cursorErr):
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid cursor"})
		case errors.As(err, &validationErr):
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"query", "limit"}, Msg: validationErr.Error()}}})
		default:
			p.log.Error("list user redemptions failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		}
		return
	}
	items := make([]redemptionResponse, len(page.Items))
	for i, row := range page.Items {
		items[i] = redemptionDTO(row)
	}
	var next *string
	if page.NextCursor != "" {
		next = &page.NextCursor
	}
	c.JSON(http.StatusOK, redemptionsResponse{Redemptions: items, NextCursor: next})
}

// parseLimitQuery reads the shared `limit` page-size query parameter (0 =
// default; 422 on a non-integer), matching the ledger endpoint's shape.
func parseLimitQuery(c *gin.Context) (int, bool) {
	raw := c.Query("limit")
	if raw == "" {
		return 0, true
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"query", "limit"}, Msg: "must be an integer"}}})
		return 0, false
	}
	return parsed, true
}

// writeRedemptionError maps the redemption vocabulary onto status codes: the
// missing-address case is a 404, the four business rejections are 409
// conflicts whose envelope carries the #850 error code verbatim.
func writeRedemptionError(c *gin.Context, log *zap.Logger, err error) {
	var redemptionErr *storage.RedemptionError
	var cursorErr *storage.PointCursorError
	var validationErr *storage.PointValidationError
	switch {
	case errors.As(err, &redemptionErr):
		if redemptionErr.Code == storage.RedemptionAddressNotFound {
			c.JSON(http.StatusNotFound, errorResponse{Error: string(redemptionErr.Code)})
			return
		}
		// payment_unavailable is not a conflict: the fee-charged redeem was
		// rejected because the WeChat Pay module is unconfigured (devops#904).
		if redemptionErr.Code == storage.RedemptionPaymentUnavailable {
			c.JSON(http.StatusServiceUnavailable, errorResponse{Error: string(redemptionErr.Code)})
			return
		}
		c.JSON(http.StatusConflict, errorResponse{Error: string(redemptionErr.Code)})
	case errors.Is(err, storage.ErrPointProductNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "product_not_found"})
	case errors.Is(err, storage.ErrPointProductSkuNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "sku_not_found"})
	case errors.Is(err, storage.ErrPointRedemptionNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "redemption_not_found"})
	case errors.As(err, &cursorErr):
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid cursor"})
	case errors.As(err, &validationErr):
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{Loc: []string{"query", "limit"}, Msg: validationErr.Error()}}})
	default:
		log.Error("points: storage error", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin handlers: products
// ─────────────────────────────────────────────────────────────────────────────

// adminProductCreateRequest is the POST body: name + points_price required,
// status defaults to draft (devops#896: a new product is pre-publication until
// an explicit PATCH or create status=active puts it on the shelf); spec_mode
// defaults to single (devops#909 — the stock behaviour every pre-SKU row has).
type adminProductCreateRequest struct {
	Name           string  `json:"name" binding:"required,max=128"`
	Description    *string `json:"description" binding:"omitempty,max=1024"`
	ImageURL       *string `json:"image_url" binding:"omitempty,max=512"`
	PointsPrice    int     `json:"points_price" binding:"required,gt=0"`
	Stock          int     `json:"stock" binding:"gte=0"`
	PerUserLimit   int     `json:"per_user_limit" binding:"gte=0"`
	ShippingPolicy string  `json:"shipping_policy" binding:"omitempty,max=16"`
	ShippingFee    int     `json:"shipping_fee" binding:"gte=0"`
	Status         string  `json:"status" binding:"omitempty,max=16"`
	SpecMode       string  `json:"spec_mode" binding:"omitempty,max=16"`
	SortOrder      int     `json:"sort_order"`
}

// adminProductPatchRequest is the PATCH body: every field optional (absent =
// unchanged); price/stock/limit/fee are absolute values.
type adminProductPatchRequest struct {
	Name           *string `json:"name" binding:"omitempty,max=128"`
	Description    *string `json:"description" binding:"omitempty,max=1024"`
	ImageURL       *string `json:"image_url" binding:"omitempty,max=512"`
	PointsPrice    *int    `json:"points_price" binding:"omitempty,gt=0"`
	Stock          *int    `json:"stock" binding:"omitempty,gte=0"`
	PerUserLimit   *int    `json:"per_user_limit" binding:"omitempty,gte=0"`
	ShippingPolicy *string `json:"shipping_policy" binding:"omitempty,max=16"`
	ShippingFee    *int    `json:"shipping_fee" binding:"omitempty,gte=0"`
	Status         *string `json:"status" binding:"omitempty,max=16"`
	SpecMode       *string `json:"spec_mode" binding:"omitempty,max=16"`
	SortOrder      *int    `json:"sort_order"`
}

// adminListProducts serves GET /api/admin/points/products — every product,
// active and inactive, for the maintenance list.
//
//	@Summary		List all products (admin)
//	@Description	Returns every product including inactive ones, sort_order ASC.
//	@Tags			points-admin
//	@Produce		json
//	@Success		200	{object}	adminProductsResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/products [get]
func (p *pointsRoutes) adminListProducts(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	rows, err := p.store.AdminListProducts(c.Request.Context())
	if err != nil {
		p.log.Error("admin list products failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	resp := adminProductsResponse{Products: make([]adminProductResponse, 0, len(rows))}
	for i := range rows {
		resp.Products = append(resp.Products, adminProductDTO(&rows[i]))
	}
	c.JSON(http.StatusOK, resp)
}

// adminCreateProduct serves POST /api/admin/points/products.
//
//	@Summary		Create a product (admin)
//	@Description	Creates one product; status defaults to draft (invisible to users until status=active). There is no DELETE — delist via PATCH status=inactive.
//	@Tags			points-admin
//	@Accept			json
//	@Produce		json
//	@Param			body	body	adminProductCreateRequest	true	"Product"
//	@Success		201		{object}	adminProductResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/products [post]
func (p *pointsRoutes) adminCreateProduct(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	var body adminProductCreateRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	status := body.Status
	if status == "" {
		status = storage.PointProductStatusDraft
	}
	// Closed enum check at the handler layer, same convention as the admin
	// redemption list's status filter: unknown tokens answer 400 invalid_status.
	if !storage.IsPointProductStatus(status) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_status"})
		return
	}
	// Shipping policy is a closed enum too (devops#904); absent means the
	// stock nationwide_free behaviour. Unknown tokens answer 400
	// invalid_shipping_policy. Spec mode is the third closed enum
	// (devops#909); absent means single.
	policy := body.ShippingPolicy
	if policy == "" {
		policy = storage.ShippingPolicyNationwideFree
	}
	if !storage.IsShippingPolicy(policy) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_shipping_policy"})
		return
	}
	specMode := body.SpecMode
	if specMode == "" {
		specMode = storage.ProductSpecModeSingle
	}
	if !storage.IsProductSpecMode(specMode) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_spec_mode"})
		return
	}
	row := &storage.PointProduct{
		Name: body.Name, Description: body.Description, ImageURL: body.ImageURL,
		PointsPrice: body.PointsPrice, Stock: body.Stock,
		PerUserLimit:   body.PerUserLimit,
		ShippingPolicy: policy, ShippingFee: body.ShippingFee,
		SpecMode: specMode, Status: status, SortOrder: body.SortOrder,
	}
	if err := p.store.AdminCreateProduct(c.Request.Context(), row); err != nil {
		p.log.Error("admin create product failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusCreated, adminProductDTO(&storage.PointProductListing{Product: *row}))
}

// adminPatchProduct serves PATCH /api/admin/points/products/:id — the single
// entry for 改价/改库存/改限购/上下架 (absolute values; no DELETE by design).
//
//	@Summary		Update a product (admin)
//	@Description	Applies partial updates: price/stock/limit as absolute values, status draft|active|inactive for shelf control. Products are never hard-deleted.
//	@Tags			points-admin
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int							true	"Product id"
//	@Param			body	body	adminProductPatchRequest	true	"Fields"
//	@Success		200		{object}	adminProductResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/products/{id} [patch]
func (p *pointsRoutes) adminPatchProduct(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	var body adminProductPatchRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	// Closed enum check at the handler layer, same convention as the admin
	// redemption list's status filter: unknown tokens answer 400 invalid_status.
	if body.Status != nil && !storage.IsPointProductStatus(*body.Status) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_status"})
		return
	}
	// The shipping policy enum is validated the same way (devops#904), the
	// spec mode enum too (devops#909).
	if body.ShippingPolicy != nil && !storage.IsShippingPolicy(*body.ShippingPolicy) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_shipping_policy"})
		return
	}
	if body.SpecMode != nil && !storage.IsProductSpecMode(*body.SpecMode) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_spec_mode"})
		return
	}
	patch := storage.ProductPatch{
		Name: body.Name, Description: body.Description, ImageURL: body.ImageURL,
		PointsPrice: body.PointsPrice, Stock: body.Stock,
		PerUserLimit: body.PerUserLimit, Status: body.Status, SortOrder: body.SortOrder,
		ShippingPolicy: body.ShippingPolicy, ShippingFee: body.ShippingFee,
		SpecMode: body.SpecMode,
	}
	row, err := p.store.AdminPatchProduct(c.Request.Context(), id, patch)
	if err != nil {
		writeRedemptionError(c, p.log, err)
		return
	}
	c.JSON(http.StatusOK, adminProductDTO(&storage.PointProductListing{Product: *row}))
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin handlers: SKU rows (devops#909)
// ─────────────────────────────────────────────────────────────────────────────

// adminSkuCreateRequest is the POST body of the SKU-row create: spec_value is
// the admin-entered size/label, stock starts the variant's inventory.
type adminSkuCreateRequest struct {
	SpecValue string `json:"spec_value" binding:"required,max=32"`
	Stock     int    `json:"stock" binding:"gte=0"`
	SortOrder int    `json:"sort_order"`
}

// adminSkuPatchRequest is the PATCH body: every field optional; stock is an
// absolute value (#849 / #909 范式).
type adminSkuPatchRequest struct {
	SpecValue *string `json:"spec_value" binding:"omitempty,max=32"`
	Stock     *int    `json:"stock" binding:"omitempty,gte=0"`
	SortOrder *int    `json:"sort_order"`
}

// adminCreateProductSku serves POST /api/admin/points/products/:id/skus —
// adds one variant row under a by_sku product.
//
//	@Summary		Create a product SKU row (admin)
//	@Description	Adds one variant (size) row with its own stock under an existing product.
//	@Tags			points-admin
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int							true	"Product id"
//	@Param			body	body	adminSkuCreateRequest		true	"SKU row"
//	@Success		201		{object}	adminSkuResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/products/{id}/skus [post]
func (p *pointsRoutes) adminCreateProductSku(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	var body adminSkuCreateRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	row := &storage.PointProductSku{
		SpecValue: body.SpecValue, Stock: body.Stock, SortOrder: body.SortOrder,
	}
	if err := p.store.AdminCreateProductSku(c.Request.Context(), id, row); err != nil {
		writeRedemptionError(c, p.log, err)
		return
	}
	c.JSON(http.StatusCreated, adminSkuDTO(row))
}

// adminPatchProductSku serves PATCH /api/admin/points/products/:id/skus/:sku_id
// — the single entry for relabel/restock/reorder (absolute stock).
//
//	@Summary		Update a product SKU row (admin)
//	@Description	Applies partial updates to one SKU row of the product; stock is an absolute value. The SKU must belong to the named product.
//	@Tags			points-admin
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int							true	"Product id"
//	@Param			sku_id	path	int							true	"SKU id"
//	@Param			body	body	adminSkuPatchRequest		true	"Fields"
//	@Success		200		{object}	adminSkuResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/products/{id}/skus/{sku_id} [patch]
func (p *pointsRoutes) adminPatchProductSku(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	skuID, ok := parseUintParam(c, "sku_id")
	if !ok {
		return
	}
	var body adminSkuPatchRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	row, err := p.store.AdminPatchProductSku(c.Request.Context(), id, skuID, storage.SkuPatch{
		SpecValue: body.SpecValue, Stock: body.Stock, SortOrder: body.SortOrder,
	})
	if err != nil {
		writeRedemptionError(c, p.log, err)
		return
	}
	c.JSON(http.StatusOK, adminSkuDTO(row))
}

// adminDeleteProductSku serves DELETE /api/admin/points/products/:id/skus/:sku_id.
// Existing orders keep their sku snapshot — rows are inventory lines, not
// history.
//
//	@Summary		Delete a product SKU row (admin)
//	@Description	Removes one SKU row of the product. Orders already placed keep their sku_id/sku_label snapshot.
//	@Tags			points-admin
//	@Param			id		path	int	true	"Product id"
//	@Param			sku_id	path	int	true	"SKU id"
//	@Success		204
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/products/{id}/skus/{sku_id} [delete]
func (p *pointsRoutes) adminDeleteProductSku(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	skuID, ok := parseUintParam(c, "sku_id")
	if !ok {
		return
	}
	if err := p.store.AdminDeleteProductSku(c.Request.Context(), id, skuID); err != nil {
		writeRedemptionError(c, p.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin handler: product image upload
// ─────────────────────────────────────────────────────────────────────────────

// productImageUploadResponse is the POST /api/admin/points/product-images
// body: the stored key plus its public URL, ready to feed image_url on
// create/PATCH.
type productImageUploadResponse struct {
	CosKey string `json:"cos_key"`
	URL    string `json:"url"`
}

// upload serves POST /api/admin/points/product-images — single-file multipart
// (field name `file`), ≤10MB, image/* sniffed, stored at points/products/<uuid>.<ext>
// in the public bucket (devops#896). The mechanics are the shared
// storeImageUpload helper; admin content is global, so unlike feedback images
// the key carries no per-user namespace.
//
//	@Summary		Upload one product image (admin)
//	@Description	Stores a single image (multipart field `file`, ≤10MB, image/*) in COS at points/products/<uuid>.<ext> and returns its object key and public URL.
//	@Tags			points-admin
//	@Accept			multipart/form-data
//	@Produce		json
//	@Param			file	formData	file	true	"Image file"
//	@Success		200		{object}	productImageUploadResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		415		{object}	errorResponse
//	@Failure		503		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/product-images [post]
func (p *pointsRoutes) upload(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	key, ok := storeImageUpload(c, p.images, "points/products/", "points: cos upload failed", p.log)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, productImageUploadResponse{CosKey: key, URL: p.images.PublicURL(key)})
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin handlers: orders
// ─────────────────────────────────────────────────────────────────────────────

// adminListRedemptions serves GET /api/admin/points/redemptions?status=&limit&cursor
// — the fulfillment queue, newest first, optionally filtered to one state.
//
//	@Summary		List redemption orders (admin)
//	@Description	Returns redemption orders newest-first with an opaque next_cursor, optionally filtered by status (pending_shipment|shipped).
//	@Tags			points-admin
//	@Produce		json
//	@Param			status	query	string	false	"Status filter (pending_shipment|shipped)"
//	@Param			limit	query	int		false	"Page size (1-50; default 50)"
//	@Param			cursor	query	string	false	"Opaque page cursor"
//	@Success		200		{object}	adminRedemptionsResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/redemptions [get]
func (p *pointsRoutes) adminListRedemptions(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	status := c.Query("status")
	if status != "" && !storage.IsRedemptionStatus(status) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_status"})
		return
	}
	limit, ok := parseLimitQuery(c)
	if !ok {
		return
	}
	page, err := p.store.AdminListRedemptions(c.Request.Context(), status, c.Query("cursor"), limit)
	if err != nil {
		writeRedemptionError(c, p.log, err)
		return
	}
	items := make([]adminRedemptionResponse, len(page.Items))
	for i, row := range page.Items {
		items[i] = adminRedemptionResponse{redemptionResponse: redemptionDTO(row), UserID: row.UserID}
	}
	var next *string
	if page.NextCursor != "" {
		next = &page.NextCursor
	}
	c.JSON(http.StatusOK, adminRedemptionsResponse{Redemptions: items, NextCursor: next})
}

// adminShipRequest is the PATCH ship body: courier company + tracking number
// arrive together — a bare number can't be matched to a carrier.
type adminShipRequest struct {
	CourierCompany string `json:"courier_company" binding:"required,max=32"`
	TrackingNo     string `json:"tracking_no" binding:"required,max=64"`
}

// adminShipRedemption serves PATCH /api/admin/points/redemptions/:id/ship —
// the terminal pending_shipment → shipped transition. Re-shipping an already
// shipped order is idempotent: the stored order (original tracking number)
// comes back with 200.
//
//	@Summary		Ship a redemption order (admin)
//	@Description	Moves a pending_shipment order to shipped with its courier company and tracking number (terminal). Shipping an already shipped order idempotently returns its current state.
//	@Tags			points-admin
//	@Accept			json
//	@Produce		json
//	@Param			id		path	string						true	"Order id"
//	@Param			body	body	adminShipRequest			true	"Courier company + tracking number"
//	@Success		200		{object}	adminRedemptionResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/points/redemptions/{id}/ship [patch]
func (p *pointsRoutes) adminShipRedemption(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id := c.Param("id")
	var body adminShipRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	row, err := p.store.AdminShipRedemption(c.Request.Context(), id, body.CourierCompany, body.TrackingNo, time.Now().UTC())
	if err != nil {
		writeRedemptionError(c, p.log, err)
		return
	}
	c.JSON(http.StatusOK, adminRedemptionResponse{redemptionResponse: redemptionDTO(row), UserID: row.UserID})
}
