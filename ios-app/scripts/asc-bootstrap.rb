#!/usr/bin/env ruby
# frozen_string_literal: true

# ASC 引导（devops#764 票面：ASC 建 App 记录 + Associated Domains capability）。
#
# 用 App Store Connect API 幂等地完成三件事（已存在则跳过）：
#   1. 注册 Bundle ID com.lipaotech.stridewise（POST /v1/bundleIds）
#   2. 给 Bundle ID 开 ASSOCIATED_DOMAINS capability（POST /v1/bundleIdCapabilities）
#   3. 创建 App 记录（POST /v1/apps，TestFlight 上传的前置）
#
# 鉴权：ES256 JWT（Ruby 标准库 OpenSSL 实现，无第三方依赖）。
# 环境变量：
#   ASC_KEY_ID     — App Store Connect API Key ID
#   ASC_ISSUER_ID  — Issuer ID
#   ASC_KEY_P8     — .p8 私钥内容（base64 或原文均可）
#
# 用法：asc-bootstrap.rb && xcodebuild -allowProvisioningUpdates ... 时
# profile 会按 capability 自动带上 entitlement。

require 'base64'
require 'json'
require 'openssl'
require 'net/http'
require 'uri'

BUNDLE_ID = ENV.fetch('STRIDE_BUNDLE_ID', 'com.lipaotech.stridewise')
APP_NAME  = ENV.fetch('STRIDE_APP_NAME', 'StrideWise')
TEAM_ID   = ENV.fetch('STRIDE_TEAM_ID', 'M4G5WA6N83')
API_HOST  = 'api.appstoreconnect.apple.com'

def fail!(msg)
  warn "::error::#{msg}"
  exit 1
end

KEY_ID = ENV['ASC_KEY_ID'] || fail!('ASC_KEY_ID 未设置')
ISSUER_ID = ENV['ASC_ISSUER_ID'] || fail!('ASC_ISSUER_ID 未设置')
raw_key = ENV['ASC_KEY_P8'] || fail!('ASC_KEY_P8 未设置')

begin
  key_data = raw_key.start_with?('-----BEGIN') ? raw_key : Base64.strict_decode64(raw_key)
  KEY = OpenSSL::PKey::EC.new(key_data)
rescue StandardError => e
  fail!("ASC_KEY_P8 解析失败：#{e.message}")
end

def b64url(data)
  Base64.urlsafe_encode64(data, padding: false)
end

# ES256：SHA256 摘要 + ECDSA ASN.1 签名转 raw r||s（各 32 字节）
def jwt_sign(input)
  digest = OpenSSL::Digest::SHA256.digest(input)
  asn1 = KEY.dsa_sign_asn1(digest)
  seq = OpenSSL::ASN1.decode(asn1)
  r = seq.value[0].value.to_s(16).rjust(64, '0')
  s = seq.value[1].value.to_s(16).rjust(64, '0')
  b64url([r + s].pack('H*'))
end

def make_token
  header = { alg: 'ES256', kid: KEY_ID }
  now = Time.now.to_i
  payload = { iss: ISSUER_ID, iat: now, exp: now + 1200 }
  input = "#{b64url(JSON.generate(header))}.#{b64url(JSON.generate(payload))}"
  "#{input}.#{jwt_sign(input)}"
end

def asc_request(method, path, body: nil)
  uri = URI("https://#{API_HOST}#{path}")
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = true
  http.open_timeout = 15
  http.read_timeout = 60
  req = Net::HTTP.const_get(method.to_s.capitalize).new(uri)
  req['Authorization'] = "Bearer #{make_token}"
  req['Content-Type'] = 'application/json'
  req.body = JSON.generate(body) if body
  res = http.request(req)
  parsed = res.body.nil? || res.body.empty? ? {} : JSON.parse(res.body)
  [res.code.to_i, parsed, res]
rescue StandardError => e
  fail!("ASC 请求 #{method} #{path} 异常：#{e.message}")
end

def expect_success(code, body, context)
  return if (200...300).cover?(code)

  detail = body.is_a?(Hash) ? body['errors'].to_s : body.inspect
  fail!("ASC #{context} 失败（HTTP #{code}）：#{detail}")
end

# ── 1. Bundle ID ────────────────────────────────────────────────────────────
code, body, = asc_request(:get, "/v1/bundleIds?filter[identifier]=#{BUNDLE_ID}")
expect_success(code, body, '查询 bundleIds')
bundle_id_resource = body.dig('data', 0)
if bundle_id_resource
  puts "Bundle ID #{BUNDLE_ID} 已存在（#{bundle_id_resource['id']}）"
else
  code, body, = asc_request(:post, '/v1/bundleIds',
    data: { type: 'bundleIds', attributes: { identifier: BUNDLE_ID, name: APP_NAME, platform: 'IOS' } })
  expect_success(code, body, '注册 Bundle ID')
  bundle_id_resource = body['data']
  puts "Bundle ID #{BUNDLE_ID} 已注册（#{bundle_id_resource['id']}）"
end
bundle_id_ref = bundle_id_resource['id']

# ── 2. Associated Domains capability ────────────────────────────────────────
code, body, = asc_request(:get, "/v1/bundleIdCapabilities?filter[bundleId]=#{bundle_id_ref}&limit=200")
expect_success(code, body, '查询 bundleIdCapabilities')
has_associated_domains = Array(body['data']).any? do |cap|
  cap.dig('attributes', 'capabilityType') == 'ASSOCIATED_DOMAINS'
end
if has_associated_domains
  puts 'ASSOCIATED_DOMAINS capability 已开启'
else
  code, body, = asc_request(:post, '/v1/bundleIdCapabilities',
    data: {
      type: 'bundleIdCapabilities',
      attributes: { capabilityType: 'ASSOCIATED_DOMAINS' },
      relationships: { bundleId: { data: { type: 'bundleIds', id: bundle_id_ref } } }
    })
  # 已存在时会返回 409 CONFLICT，视为成功
  if code == 409
    puts 'ASSOCIATED_DOMAINS capability 已存在（409 视为幂等成功）'
  else
    expect_success(code, body, '开启 ASSOCIATED_DOMAINS')
    puts 'ASSOCIATED_DOMAINS capability 已开启'
  end
end

# ── 3. App 记录（TestFlight 上传前置）────────────────────────────────────────
code, body, = asc_request(:get, "/v1/apps?filter[bundleId]=#{BUNDLE_ID}")
expect_success(code, body, '查询 apps')
if Array(body['data']).any?
  puts "App 记录已存在（#{body.dig('data', 0, 'id')}）"
else
  code, body, = asc_request(:post, '/v1/apps',
    data: { type: 'apps', attributes: { name: APP_NAME, bundleId: BUNDLE_ID, platform: 'IOS' } })
  expect_success(code, body, '创建 App 记录')
  puts "App 记录已创建（#{body.dig('data', 'id')}，Team #{TEAM_ID}）"
end

puts 'ASC 引导完成：bundle id + associated domains capability + app record 均就绪'
