#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { IotMonitoringStack } from '../lib/iot-monitoring-stack';

const app = new App();

new IotMonitoringStack(app, 'IotMonitoringStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
