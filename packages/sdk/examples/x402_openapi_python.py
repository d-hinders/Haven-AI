#!/usr/bin/env python3
"""
Minimal non-TypeScript x402 proof of concept for the Haven OpenAPI surface.

Requires:
  pip install requests eth-account

Environment:
  HAVEN_API_KEY        sk_agent_* from Haven
  HAVEN_DELEGATE_KEY   local agent delegate private key; never sent to Haven
  HAVEN_API_URL        default: https://havenbackend-production-8a00.up.railway.app
  HAVEN_X402_URL       default: $HAVEN_API_URL/demo/x402/data

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
from eth_account import Account


API = os.environ.get("HAVEN_API_URL", "https://havenbackend-production-8a00.up.railway.app").rstrip("/")
PAID_URL = os.environ.get("HAVEN_X402_URL", f"{API}/demo/x402/data")
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
signature = Account._sign_hash(sign_hash, private_key=DELEGATE_KEY).signature.hex()
if not signature.startswith("0x"):
  signature = "0x" + signature

result = post_haven(f"/payments/{authorization['payment_id']}/sign", {"signature": signature})
tx_hash = result["tx_hash"]

paid = requests.get(PAID_URL, headers={"PAYMENT-SIGNATURE": b64_json({"txHash": tx_hash})}, timeout=30)
print(json.dumps({
  "status": paid.status_code,
  "payment_id": authorization["payment_id"],
  "tx_hash": tx_hash,
  "response": paid.json(),
}, indent=2))
