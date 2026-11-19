# TFM Interoperability API

Prototype of the UOC Master's thesis *Blockchain Network Interoperability: The Challenge of Coexisting Multiple Infrastructures*.
It offers a common REST interface to store, retrieve and verify data on the XRP Ledger and on an EVM chain (XRPL EVM),
including a cross-chain operation that stores a record on the EVM chain and anchors its SHA-256 hash on the XRP Ledger.

> Status: PAC3 in progress. T3.1–T3.3 done (environment, XRP Ledger adapter, EVM adapter and contract); T3.4 (REST API and cross-chain operation) in testing.

## Requirements

- Node.js 20 or later
- Docker (Docker Desktop on macOS) for the local networks
- Foundry (`forge`) for the smart contract: https://getfoundry.sh

## Structure

```
src/            API (TypeScript, Express)
  adapters/     one adapter per chain (Adapter pattern, NFR2)
  domain/       data model and hashing
  store/        local SQLite store (states, nonces)
contracts/      RecordStore smart contract (Solidity, Foundry)
docker/         configuration of the local rippled node
test/           unit tests (Vitest)
```

## Set-up

```bash
npm install
cp .env.example .env          # then fill in the values
docker compose up -d          # local rippled (stand-alone) and Anvil
```

Contract (in `contracts/`):

```bash
cd contracts
forge install foundry-rs/forge-std --no-git
forge test
PRIVATE_KEY=<key of the API account> forge script script/Deploy.s.sol --rpc-url <EVM_RPC_URL> --broadcast
```

Write the deployed address in `EVM_CONTRACT_ADDRESS` and the block printed by the script in `EVM_FROM_BLOCK`.
The account that deploys the contract becomes its writer, so it must be the account of `EVM_PRIVATE_KEY`.
Then test the EVM adapter:

```bash
npm run evm:smoke     # stores a record in the contract, reads it back with and without the transaction reference
```

For the XRPL EVM Testnet use `EVM_RPC_URL=https://rpc.testnet.xrplevm.org/` and `EVM_CHAIN_ID=1449000`
(test XRP from https://faucet.xrplevm.org).

XRP Ledger accounts (with the local node running and `XRPL_STANDALONE=true` in `.env`):

```bash
npm run xrpl:setup    # creates and funds the two accounts of the API; copy the output into .env
npm run xrpl:smoke    # stores a record, reads it back with and without the local store
```

For the XRPL Testnet, set `XRPL_WS_URL=wss://s.altnet.rippletest.net:51233` and `XRPL_STANDALONE=false`;
`xrpl:setup` then funds the accounts with the public faucet.

Notes on the local networks:

- In stand-alone mode, rippled only closes a ledger when it is asked to:
  `docker compose exec rippled rippled --silent ledger_accept`.
  The finality checks (SR9) are tested on the public test networks.
- Anvil confirms transactions immediately; its first accounts and keys are printed in `docker compose logs anvil`.

## Run

```bash
npm run dev      # starts the API (it needs EVM_CONTRACT_ADDRESS); prints the public addresses of the API (SR12)
npm test         # unit tests
```

The interface is described in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1). Summary:

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Status of the API and of each chain, warnings of low balance and pending anchors (public) |
| POST | `/records` | `{"chain": "xrpl" \| "evm", "payload": "..."}` stores a record on one chain |
| GET | `/records/:chain/:id` | Reads a record |
| POST | `/records/cross-chain` | `{"payload": "..."}` stores on the EVM chain and anchors the SHA-256 hash on the XRP Ledger (201, or 202 if the anchor is pending) |
| GET | `/records/cross-chain/:id` | Record, state and references on both chains |
| GET | `/records/cross-chain/:id/verify` | Compares the record with its anchor |

Every request to `/records` needs `X-API-Key`. Write requests also need `X-Timestamp` (Unix seconds) and a
unique `X-Nonce` (16–128 characters), and are limited per key and minute.

With the API running, `npm run api:smoke` calls every route and prints the hash of the anchor transaction.

## Independent verification (SR5)

`scripts/verify.ts` checks a cross-chain record without the API, using only public nodes and the published
addresses of the API:

```bash
XRPL_WS_URL=wss://s.altnet.rippletest.net:51233 EVM_RPC_URL=https://rpc.testnet.xrplevm.org/ \
API_XRPL_ACCOUNT=<XRP Ledger account of the API> API_EVM_CONTRACT=<RecordStore address> \
npm run verify -- <hash of the anchor transaction>
```

## Security notes

- Secrets are only read from `.env`, which is excluded from Git (SR3).
- Only test networks are used, without real funds (LR2).

## Licence

MIT
