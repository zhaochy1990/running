// addresses.go is the address-book surface (devops#884; contract per
// devops#850 resolution): the user-side CRUD plus the default-address flip.
// The admin tier has no surface here — an address book is strictly the
// owner's; orders already hold receiver snapshots.
//
//	User: GET    /api/users/me/addresses
//	      POST   /api/users/me/addresses
//	      PATCH  /api/users/me/addresses/:id
//	      DELETE /api/users/me/addresses/:id
//	      PATCH  /api/users/me/addresses/:id/default
package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// AddressStore is the address-book persistence port (devops#884). Satisfied
// by *storage.Store.
type AddressStore interface {
	ListAddresses(ctx context.Context, userID string) ([]storage.UserAddress, error)
	CreateAddress(ctx context.Context, userID string, in storage.AddressInput) (*storage.UserAddress, error)
	UpdateAddress(ctx context.Context, userID string, id uint64, patch storage.AddressPatch) (*storage.UserAddress, error)
	DeleteAddress(ctx context.Context, userID string, id uint64) error
	SetDefaultAddress(ctx context.Context, userID string, id uint64) (*storage.UserAddress, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type addressRoutes struct {
	store AddressStore
	log   *zap.Logger
}

func newAddressRoutes(store AddressStore, log *zap.Logger) *addressRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &addressRoutes{store: store, log: log}
}

// register mounts the user-tier surface on the default-deny group.
func (a *addressRoutes) register(rg *gin.RouterGroup) {
	if a.store == nil {
		return
	}
	rg.GET("/api/users/me/addresses", a.list)
	rg.POST("/api/users/me/addresses", a.create)
	rg.PATCH("/api/users/me/addresses/:id", a.update)
	rg.DELETE("/api/users/me/addresses/:id", a.remove)
	rg.PATCH("/api/users/me/addresses/:id/default", a.setDefault)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

type addressResponse struct {
	ID            uint64 `json:"id"`
	ReceiverName  string `json:"receiver_name"`
	ReceiverPhone string `json:"receiver_phone"`
	Province      string `json:"province"`
	City          string `json:"city"`
	District      string `json:"district"`
	AddressDetail string `json:"address_detail"`
	IsDefault     bool   `json:"is_default"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

type addressesResponse struct {
	Addresses []addressResponse `json:"addresses"`
}

// addressCreateRequest is the POST body: every address field required.
type addressCreateRequest struct {
	ReceiverName  string `json:"receiver_name" binding:"required,max=64"`
	ReceiverPhone string `json:"receiver_phone" binding:"required,max=32"`
	Province      string `json:"province" binding:"required,max=32"`
	City          string `json:"city" binding:"required,max=32"`
	District      string `json:"district" binding:"required,max=32"`
	AddressDetail string `json:"address_detail" binding:"required,max=255"`
	IsDefault     bool   `json:"is_default"`
}

// addressPatchRequest is the PATCH body: every field optional (absent =
// unchanged).
type addressPatchRequest struct {
	ReceiverName  *string `json:"receiver_name" binding:"omitempty,max=64"`
	ReceiverPhone *string `json:"receiver_phone" binding:"omitempty,max=32"`
	Province      *string `json:"province" binding:"omitempty,max=32"`
	City          *string `json:"city" binding:"omitempty,max=32"`
	District      *string `json:"district" binding:"omitempty,max=32"`
	AddressDetail *string `json:"address_detail" binding:"omitempty,max=255"`
	IsDefault     *bool   `json:"is_default"`
}

func addressDTO(r *storage.UserAddress) addressResponse {
	return addressResponse{
		ID: r.ID, ReceiverName: r.ReceiverName, ReceiverPhone: r.ReceiverPhone,
		Province: r.Province, City: r.City, District: r.District,
		AddressDetail: r.AddressDetail, IsDefault: r.IsDefault,
		CreatedAt: r.CreatedAt.UTC().Format(timeFormat),
		UpdatedAt: r.UpdatedAt.UTC().Format(timeFormat),
	}
}

// writeAddressError maps storage sentinels onto status codes: the 11th entry
// is a 409, a missing/foreign id a 404.
func writeAddressError(c *gin.Context, log *zap.Logger, err error) {
	var validationErr *storage.AddressValidationError
	switch {
	case errors.Is(err, storage.ErrAddressLimitReached):
		c.JSON(http.StatusConflict, errorResponse{Error: "address_limit_reached"})
	case errors.Is(err, storage.ErrAddressNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "address_not_found"})
	case errors.As(err, &validationErr):
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_address"})
	default:
		log.Error("addresses: storage error", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// list serves GET /api/users/me/addresses — the whole book, default first.
//
//	@Summary		List my address book
//	@Description	Returns the caller's addresses, default first, newest within each group.
//	@Tags			addresses
//	@Produce		json
//	@Success		200	{object}	addressesResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/addresses [get]
func (a *addressRoutes) list(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	rows, err := a.store.ListAddresses(c.Request.Context(), uid)
	if err != nil {
		writeAddressError(c, a.log, err)
		return
	}
	resp := addressesResponse{Addresses: make([]addressResponse, 0, len(rows))}
	for i := range rows {
		resp.Addresses = append(resp.Addresses, addressDTO(&rows[i]))
	}
	c.JSON(http.StatusOK, resp)
}

// create serves POST /api/users/me/addresses — capped at 10 per user; the
// first entry becomes the default automatically.
//
//	@Summary		Add an address
//	@Description	Creates one address book entry (≤10 per user). The first entry a user creates becomes their default; an explicit is_default clears the previous default.
//	@Tags			addresses
//	@Accept			json
//	@Produce		json
//	@Param			body	body	addressCreateRequest	true	"Address"
//	@Success		201		{object}	addressResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/addresses [post]
func (a *addressRoutes) create(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var body addressCreateRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	row, err := a.store.CreateAddress(c.Request.Context(), uid, storage.AddressInput{
		ReceiverName: body.ReceiverName, ReceiverPhone: body.ReceiverPhone,
		Province: body.Province, City: body.City, District: body.District,
		AddressDetail: body.AddressDetail, IsDefault: body.IsDefault,
	})
	if err != nil {
		writeAddressError(c, a.log, err)
		return
	}
	c.JSON(http.StatusCreated, addressDTO(row))
}

// update serves PATCH /api/users/me/addresses/:id — partial edit; flipping
// is_default=true clears the other default in the same transaction.
//
//	@Summary		Update an address
//	@Description	Applies a partial edit to one owned address; absent fields stay unchanged.
//	@Tags			addresses
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int							true	"Address id"
//	@Param			body	body	addressPatchRequest			true	"Fields"
//	@Success		200		{object}	addressResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/addresses/{id} [patch]
func (a *addressRoutes) update(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	var body addressPatchRequest
	if !bindRaceCalendarJSON(c, &body, "invalid_body") {
		return
	}
	row, err := a.store.UpdateAddress(c.Request.Context(), uid, id, storage.AddressPatch{
		ReceiverName: body.ReceiverName, ReceiverPhone: body.ReceiverPhone,
		Province: body.Province, City: body.City, District: body.District,
		AddressDetail: body.AddressDetail, IsDefault: body.IsDefault,
	})
	if err != nil {
		writeAddressError(c, a.log, err)
		return
	}
	c.JSON(http.StatusOK, addressDTO(row))
}

// remove serves DELETE /api/users/me/addresses/:id — hard delete; orders hold
// snapshots, so history is untouched.
//
//	@Summary		Delete an address
//	@Description	Hard-deletes one owned address. Redemption orders keep their receiver snapshot, so history is unaffected.
//	@Tags			addresses
//	@Param			id	path	int	true	"Address id"
//	@Success		204	{object}	nil
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/addresses/{id} [delete]
func (a *addressRoutes) remove(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	if err := a.store.DeleteAddress(c.Request.Context(), uid, id); err != nil {
		writeAddressError(c, a.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// setDefault serves PATCH /api/users/me/addresses/:id/default — moves the
// single default flag (others cleared in the same transaction).
//
//	@Summary		Set the default address
//	@Description	Makes one owned address the default; the previous default is cleared in the same transaction.
//	@Tags			addresses
//	@Produce		json
//	@Param			id	path	int				true	"Address id"
//	@Success		200	{object}	addressResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/addresses/{id}/default [patch]
func (a *addressRoutes) setDefault(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	row, err := a.store.SetDefaultAddress(c.Request.Context(), uid, id)
	if err != nil {
		writeAddressError(c, a.log, err)
		return
	}
	c.JSON(http.StatusOK, addressDTO(row))
}
