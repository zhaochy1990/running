// cmd_api_wxpayopenid.go adapts the authsvc client to the API's
// WxPayOpenIDResolver port (devops#904/#905 prepay fix): the pay body now
// carries the miniprogram's one-time wx.login() code, and the API resolves
// it to the payer openid through the auth-service's internal plane. The
// shared secret riding X-Internal-Token is the deployment's
// STRIDE_WORKER_API_INTERNAL_TOKEN — the same value the auth-service reads
// as INTERNAL_API_TOKEN, so no new configuration exists.
package main

import (
	"context"

	"github.com/zhaochy1990/stride/internal/authsvc"
)

// wxpayOpenIDResolver closes the auth-service client and the internal-plane
// token over the code → openid exchange.
type wxpayOpenIDResolver struct {
	client *authsvc.Client
	token  string
}

// WeChatCode2Session satisfies api.WxPayOpenIDResolver.
func (r wxpayOpenIDResolver) WeChatCode2Session(ctx context.Context, code string) (string, error) {
	return r.client.WeChatCode2Session(ctx, r.token, code)
}
