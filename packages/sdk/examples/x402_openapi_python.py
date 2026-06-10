#!/usr/bin/env python3
"""
Minimal non-TypeScript x402 proof of concept for the Haven OpenAPI surface.

Requires:
  pip install requests eth-keys

Environment:
  HAVEN_API_KEY        sk_agent_* from Haven
  HAVEN_DELEGATE_KEY   local agent delegate private key; never sent to Haven
  HAVEN_API_URL        default: https://havenbackend-production-8a00.up.railway.app
  HAVEN_X402_URL       required: URL of any x402-gated (HTTP 402) resource to pay for

This intentionally uses only documented HTTP endpoints:
  GET  /openapi.json
  POST /x402/authorize
  POST /payments/{id}/sign
"""

import base64
import json
import os
import sys

import requests
from eth_keys import keys


API = os.environ.get("HAVEN_API_URL", "https://havenbackend-production-8a00.up.railway.app").rstrip("/")
PAID_URL = os.environ["HAVEN_X402_URL"]  # any x402-gated resource to pay for
API_KEY = os.environ["HAVEN_API_KEY"]
DELEGATE_KEY = os.environ["HAVEN_DELEGATE_KEY"]


def b64_json(value):
  return base64.b64encode(json.dumps(value).encode()).decode()


def decode_payment_required(response):
  header = response.headers.get("PAYMENT-REQUIRED")
  if not header:
    raise RuntimeError(f"Expected PAYMENT-REQUIRED header, got HTTP {response.status_code}: {response.text}")
  return json.loads(base64.b64decode(header).decode())


def post_haven(path, payload):
  response = requests.post(
    f"{API}{path}",
    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
    json=payload,
    timeout=60,
  )
  body = response.json()
  if response.status_code >= 400:
    raise RuntimeError(f"{path} failed with HTTP {response.status_code}: {body}")
  return body


def sign_raw_hash(sign_hash, private_key):
  """Sign the raw Safe hash exactly as /payments/{id}/sign expects."""
  key_hex = private_key[2:] if private_key.startswith("0x") else private_key
  hash_hex = sign_hash[2:] if sign_hash.startswith("0x") else sign_hash
  signature = keys.PrivateKey(bytes.fromhex(key_hex)).sign_msg_hash(bytes.fromhex(hash_hex))
  v = signature.v + 27 if signature.v in (0, 1) else signature.v
  return (
    "0x"
    + signature.r.to_bytes(32, "big").hex()
    + signature.s.to_bytes(32, "big").hex()
    + bytes([v]).hex()
  )


spec = requests.get(f"{API}/openapi.json", timeout=30).json()
authorize_path = "/x402/authorize" if "/x402/authorize" in spec["paths"] else "/x402"

initial = requests.get(PAID_URL, timeout=30)
if initial.status_code != 402:
  raise RuntimeError(f"Expected paid resource to return HTTP 402, got {initial.status_code}")

payment_required = decode_payment_required(initial)
accepted = payment_required["accepts"][0]

authorization = post_haven(authorize_path, {
  "url": payment_required["resource"]["url"],
  "payTo": accepted["payTo"],
  "merchantPayTo": accepted["payTo"],
  "amount": accepted.get("amount") or accepted["maxAmountRequired"],
  "asset": accepted["asset"],
  "network": accepted["network"],
  "description": payment_required["resource"].get("description"),
  "idempotencyKey": f"python-openapi:{payment_required['resource']['url']}",
})

if authorization.get("status") == "pending_approval":
  print(json.dumps({
    "payment_id": authorization["payment_id"],
    "next_action": authorization.get("next_action"),
    "message": authorization.get("message"),
  }, indent=2))
  sys.exit("Payment is waiting for approval in Haven. Re-run after approval and use /payments/{id}/resume_state.")

sign_hash = authorization["sign_data"]["hash"]
signature = sign_raw_hash(sign_hash, DELEGATE_KEY)

result = post_haven(f"/payments/{authorization['payment_id']}/sign", {"signature": signature})
tx_hash = result["tx_hash"]

paid = requests.get(PAID_URL, headers={"PAYMENT-SIGNATURE": b64_json({"txHash": tx_hash})}, timeout=30)
print(json.dumps({
  "status": paid.status_code,
  "payment_id": authorization["payment_id"],
  "tx_hash": tx_hash,
  "response": paid.json(),
}, indent=2))
