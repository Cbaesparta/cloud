# Cloud IoT Monitoring Platform

Monorepo scaffold for a serverless IoT monitoring platform using AWS IoT Core, Lambda, DynamoDB, and a React dashboard.

## Repository Structure

- `/infrastructure` - AWS CDK stack for IoT rule routing, telemetry Lambda, DynamoDB table, DLQ, and IoT security policy.
- `/backend/lambdas` - Lambda source code for telemetry processing and schema validation.
- `/frontend` - React dashboard with MQTT subscription, command publishing, and historical data fetch support.

## Security Notes

- IAM permissions are intentionally scoped to specific DynamoDB table and SQS DLQ resources in the CDK stack.
- MQTT policy uses device-scoped topic namespaces to prevent cross-device publish/subscribe access.
- Frontend command publishing should be paired with Cognito identity roles that only allow `devices/{deviceId}/commands` topics.

## Quick Start

```bash
npm install
npm run build
npm run lint
npm run test
```

### Infrastructure

```bash
cd infrastructure
npm run synth
```

### Frontend

Set these environment variables in `/frontend/.env`:

- `VITE_IOT_WS_URL` - Signed AWS IoT MQTT over WebSocket URL
- `VITE_API_BASE_URL` - API Gateway base URL

Then run:

```bash
cd frontend
npm run dev
```
