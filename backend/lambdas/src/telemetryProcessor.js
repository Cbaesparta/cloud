const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const Ajv = require('ajv');

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqsClient = new SQSClient({});

const ajv = new Ajv({ allErrors: true, removeAdditional: true });
const validateTelemetry = ajv.compile({
  type: 'object',
  additionalProperties: true,
  required: ['deviceId', 'timestamp', 'sensorType', 'value'],
  properties: {
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
    timestamp: { type: 'string', minLength: 1 },
    sensorType: { type: 'string', minLength: 1, maxLength: 64 },
    value: { type: 'number' },
    unit: { type: 'string', maxLength: 24 },
    metadata: { type: 'object', additionalProperties: true },
  },
});

const isIso8601 = (value) => !Number.isNaN(Date.parse(value));

const parseEvent = (event) => {
  if (!event) {
    return null;
  }

  if (typeof event === 'string') {
    return JSON.parse(event);
  }

  if (typeof event.payload === 'string') {
    return JSON.parse(event.payload);
  }

  if (typeof event.payload === 'object' && event.payload !== null) {
    return event.payload;
  }

  return event;
};

const sendToDlq = async (reason, rawPayload) => {
  if (!process.env.DEAD_LETTER_QUEUE_URL) {
    return;
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: process.env.DEAD_LETTER_QUEUE_URL,
      MessageBody: JSON.stringify({
        reason,
        rawPayload,
        receivedAt: new Date().toISOString(),
      }),
    }),
  );
};

exports.handler = async (event) => {
  const parsedPayload = parseEvent(event);

  if (!parsedPayload || !validateTelemetry(parsedPayload) || !isIso8601(parsedPayload.timestamp)) {
    const errors = validateTelemetry.errors ?? [];
    console.error('Telemetry validation failed', { errors, parsedPayload });
    await sendToDlq(
      isIso8601(parsedPayload?.timestamp) ? 'schema_validation_failed' : 'invalid_timestamp',
      event,
    );

    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Invalid telemetry payload' }),
    };
  }

  const epochSeconds = Math.floor(Date.parse(parsedPayload.timestamp) / 1000);
  const ttlSeconds = epochSeconds + 60 * 60 * 24 * 30;

  const item = {
    deviceId: parsedPayload.deviceId,
    timestamp: parsedPayload.timestamp,
    sensorType: parsedPayload.sensorType,
    value: parsedPayload.value,
    unit: parsedPayload.unit ?? null,
    metadata: parsedPayload.metadata ?? {},
    receivedAt: new Date().toISOString(),
    expiresAt: ttlSeconds,
  };

  try {
    await ddbClient.send(
      new PutCommand({
        TableName: process.env.SENSOR_TABLE_NAME,
        Item: item,
      }),
    );

    console.info('Telemetry persisted', {
      deviceId: item.deviceId,
      sensorType: item.sensorType,
      timestamp: item.timestamp,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Telemetry accepted' }),
    };
  } catch (error) {
    console.error('Failed to store telemetry', { error, payload: parsedPayload });
    await sendToDlq('dynamodb_write_failed', parsedPayload);

    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Telemetry processing failed' }),
    };
  }
};

exports._internal = {
  parseEvent,
  isIso8601,
};
