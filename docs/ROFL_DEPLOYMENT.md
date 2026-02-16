# ROFL Deployment Guide

Deploy your own private ekai-gateway instance on Oasis Network using ROFL (Runtime Off-chain Logic).

## Why ROFL?

- **Private**: Your API keys stay secure, in a TEE (Trusted Execution Environment)
- **Isolated**: Each user deploys their own instance
- **Verifiable**: Code execution can be verified on-chain

---

## Demo

[![ROFL Deployment Demo Video](https://img.youtube.com/vi/hZC1Y_dWdhI/maxresdefault.jpg)](https://www.youtube.com/watch?v=hZC1Y_dWdhI)

Watch the deployment walkthrough: [ROFL Deployment Demo](https://www.youtube.com/watch?v=hZC1Y_dWdhI)

---

## Prerequisites

1. **Oasis CLI** (v0.18.x+)
   Install from [L15 CLI Reference](https://cli.oasis.io), then verify:
   ```bash
   oasis --version
   ```

2. **Docker**
   ```bash
   docker --version
   ```

3. **Funded Wallet**
   ```bash
   oasis wallet create my_wallet
   # Get testnet tokens: https://faucet.testnet.oasis.io/
   oasis wallet show my_wallet --network testnet --paratime sapphire
   ```

4. **API Keys** (at least one): OpenAI, Anthropic, or xAI

## Deployment

```bash
# 1. Clone
git clone https://github.com/ekailabs/ekai-gateway.git
cd ekai-gateway

# 2. Create rofl.yaml from template
cp rofl.yaml.template rofl.yaml

# 3. Register app
oasis rofl create --network testnet --paratime sapphire

# 4. Set secrets (at least one)
echo -n "sk-your-openai-key" | oasis rofl secret set OPENAI_API_KEY -
echo -n "sk-ant-your-anthropic-key" | oasis rofl secret set ANTHROPIC_API_KEY -
echo -n "xai-your-xai-key" | oasis rofl secret set XAI_API_KEY -

# 5. Build
oasis rofl build

# 6. Update on-chain config
oasis rofl update

# 7. Push
oasis rofl push

# 8. Deploy
oasis rofl deploy

# 9. Get your endpoints
oasis rofl machine show
```

## Your Endpoints

After `oasis rofl machine show`, you'll see:

```
Proxy:
  Domain: m1234.test-proxy-b.rofl.app
  Ports:
    3001: https://p3001.m1234.test-proxy-b.rofl.app  # Gateway API
    3000: https://p3000.m1234.test-proxy-b.rofl.app  # Dashboard
```

## Testing

Replace `m1234` with your actual domain from the output above.

```bash
# Health check
curl https://p3001.m1234.test-proxy-b.rofl.app/health

# List models
curl https://p3001.m1234.test-proxy-b.rofl.app/v1/models

# Chat completion (OpenAI)
curl https://p3001.m1234.test-proxy-b.rofl.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (Anthropic)
curl https://p3001.m1234.test-proxy-b.rofl.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Use with OpenAI-Compatible Tools

```bash
export OPENAI_BASE_URL=https://p3001.m1234.test-proxy-b.rofl.app/v1
export OPENAI_API_KEY="not-needed"  # Keys are in TEE
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `oasis rofl show` | View app status |
| `oasis rofl machine show` | View endpoints and machine info |
| `oasis rofl machine logs` | View logs |
| `oasis rofl secret list` | List secrets |

## Troubleshooting

**"app identifier already defined"**: Remove `deployments` section from `rofl.yaml` and run `oasis rofl create` again.

**"forbidden"**: You're using a different wallet than the one that created the app. Check with `oasis wallet list`.

**Build failures**: Ensure Docker is running (`docker ps`) and you have disk space (`df -h`).

**Insufficient funds**: Get testnet tokens from https://faucet.testnet.oasis.io/

## Resources

- [Oasis ROFL Docs](https://docs.oasis.io/rofl/)
- [Oasis CLI Reference](https://cli.oasis.io)
- [Testnet Faucet](https://faucet.testnet.oasis.io/)
