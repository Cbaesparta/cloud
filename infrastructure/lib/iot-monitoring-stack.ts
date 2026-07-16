import {
  Stack,
  StackProps,
  aws_lambda as lambda,
  aws_dynamodb as dynamodb,
  aws_iot as iot,
  aws_iam as iam,
  aws_sqs as sqs,
  aws_logs as logs,
  Duration,
  CfnOutput,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class IotMonitoringStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const deadLetterQueue = new sqs.Queue(this, 'TelemetryDlq', {
      queueName: 'telemetry-processing-dlq',
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const sensorDataTable = new dynamodb.Table(this, 'SensorDataTable', {
      tableName: 'SensorData',
      partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecovery: true,
      removalPolicy: undefined,
    });

    sensorDataTable.addGlobalSecondaryIndex({
      indexName: 'sensorType-timestamp-index',
      partitionKey: { name: 'sensorType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const telemetryProcessor = new lambda.Function(this, 'TelemetryProcessor', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'telemetryProcessor.handler',
      code: lambda.Code.fromAsset('../backend/lambdas/src'),
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        SENSOR_TABLE_NAME: sensorDataTable.tableName,
        DEAD_LETTER_QUEUE_URL: deadLetterQueue.queueUrl,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Least-privilege IAM scope: Lambda can only write to this exact table and this exact index path.
    telemetryProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [sensorDataTable.tableArn],
      }),
    );

    // Least-privilege IAM scope: Lambda can only send failed payloads to the dedicated DLQ.
    telemetryProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [deadLetterQueue.queueArn],
      }),
    );

    const topicRule = new iot.CfnTopicRule(this, 'TelemetryTopicRule', {
      topicRulePayload: {
        sql: "SELECT *, topic() as mqttTopic FROM 'devices/+/telemetry'",
        awsIotSqlVersion: '2016-03-23',
        ruleDisabled: false,
        actions: [
          {
            lambda: {
              functionArn: telemetryProcessor.functionArn,
            },
          },
        ],
      },
    });

    telemetryProcessor.addPermission('AllowIotRuleInvoke', {
      principal: new iam.ServicePrincipal('iot.amazonaws.com'),
      sourceArn: topicRule.attrArn,
      action: 'lambda:InvokeFunction',
    });

    // MQTT topic policy follows topic-prefix scoping so each device can only publish/subscribe
    // to its own namespaced topics (for example devices/${iot:Connection.Thing.ThingName}/telemetry).
    new iot.CfnPolicy(this, 'ScopedDevicePolicy', {
      policyName: 'ScopedDeviceTelemetryPolicy',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['iot:Connect'],
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:client/\${iot:Connection.Thing.ThingName}`,
            ],
          },
          {
            Effect: 'Allow',
            Action: ['iot:Publish'],
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topic/devices/\${iot:Connection.Thing.ThingName}/telemetry`,
              `arn:aws:iot:${this.region}:${this.account}:topic/devices/\${iot:Connection.Thing.ThingName}/status`,
            ],
          },
          {
            Effect: 'Allow',
            Action: ['iot:Subscribe'],
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topicfilter/devices/\${iot:Connection.Thing.ThingName}/commands`,
            ],
          },
          {
            Effect: 'Allow',
            Action: ['iot:Receive'],
            Resource: [
              `arn:aws:iot:${this.region}:${this.account}:topic/devices/\${iot:Connection.Thing.ThingName}/commands`,
            ],
          },
        ],
      },
    });

    new iot.CfnThingType(this, 'SensorThingType', {
      thingTypeName: 'SensorNode',
      thingTypeDescription: 'Thing type for telemetry-producing sensor nodes.',
      thingTypeProperties: {
        searchableAttributes: ['location', 'sensorType'],
      },
    });

    new CfnOutput(this, 'SensorDataTableName', {
      value: sensorDataTable.tableName,
    });

    new CfnOutput(this, 'TelemetryDlqUrl', {
      value: deadLetterQueue.queueUrl,
    });
  }
}
