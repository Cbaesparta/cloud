import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from 'recharts';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

type TelemetryPoint = {
  timestamp: string;
  value: number;
  sensorType: string;
};

type DeviceState = {
  deviceId: string;
  lastSeen: number;
  latestValue: number;
  sensorType: string;
};

const MAX_POINTS_PER_DEVICE = 60;
const ONLINE_THRESHOLD_MS = 90_000;

const wsUrl = import.meta.env.VITE_IOT_WS_URL as string | undefined;
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

export function MqttDashboard() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [devices, setDevices] = useState<Record<string, DeviceState>>({});
  const [seriesByDevice, setSeriesByDevice] = useState<Record<string, TelemetryPoint[]>>({});
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [commandPayload, setCommandPayload] = useState<string>('{"action":"restart"}');
  const [historicalData, setHistoricalData] = useState<TelemetryPoint[]>([]);
  const [historyStatus, setHistoryStatus] = useState<string>('');
  const clientRef = useRef<MqttClient | null>(null);

  useEffect(() => {
    if (!wsUrl) {
      setConnectionState('error');
      return;
    }

    setConnectionState('connecting');

    const client = mqtt.connect(wsUrl, {
      reconnectPeriod: 5_000,
      clean: true,
      connectTimeout: 10_000,
    });

    clientRef.current = client;

    client.on('connect', () => {
      setConnectionState('connected');
      client.subscribe('devices/+/telemetry', { qos: 1 });
      client.subscribe('devices/+/status', { qos: 1 });
    });

    client.on('reconnect', () => {
      setConnectionState('reconnecting');
    });

    client.on('close', () => {
      setConnectionState('disconnected');
    });

    client.on('error', (error) => {
      console.error('MQTT client error', error);
      setConnectionState('error');
    });

    client.on('message', (topic, payloadBuffer) => {
      try {
        const payload = JSON.parse(payloadBuffer.toString()) as {
          deviceId?: string;
          timestamp?: string;
          sensorType?: string;
          value?: number;
        };

        const topicParts = topic.split('/');
        const topicDeviceId = topicParts[1];
        const deviceId = payload.deviceId || topicDeviceId;

        // MQTT topic security best practice: only trust telemetry routed through the device-scoped topic namespace.
        if (!deviceId || topicParts[0] !== 'devices') {
          return;
        }

        const timestamp = payload.timestamp ?? new Date().toISOString();
        const sensorType = payload.sensorType ?? 'unknown';
        const value = typeof payload.value === 'number' ? payload.value : 0;

        setDevices((previous) => ({
          ...previous,
          [deviceId]: {
            deviceId,
            lastSeen: Date.now(),
            latestValue: value,
            sensorType,
          },
        }));

        setSeriesByDevice((previous) => {
          const points = [...(previous[deviceId] ?? []), { timestamp, value, sensorType }];
          return {
            ...previous,
            [deviceId]: points.slice(-MAX_POINTS_PER_DEVICE),
          };
        });

        setSelectedDeviceId((current) => current || deviceId);
      } catch (error) {
        console.error('Failed to parse MQTT payload', error);
      }
    });

    return () => {
      client.end(true);
    };
  }, []);

  const selectedSeries = useMemo(
    () => (selectedDeviceId ? seriesByDevice[selectedDeviceId] ?? [] : []),
    [selectedDeviceId, seriesByDevice],
  );

  const publishCommand = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedDeviceId || !clientRef.current || connectionState === 'error') {
      return;
    }

    try {
      const body = JSON.parse(commandPayload);
      const topic = `devices/${selectedDeviceId}/commands`;

      // IAM + policy alignment: frontend should only publish to command topics authorized by Cognito identity policy.
      clientRef.current.publish(topic, JSON.stringify(body), { qos: 1 });
    } catch (error) {
      console.error('Command must be valid JSON', error);
    }
  };

  const fetchHistory = async () => {
    if (!selectedDeviceId || !apiBaseUrl) {
      return;
    }

    setHistoryStatus('Loading history...');

    try {
      const response = await fetch(`${apiBaseUrl}/devices/${selectedDeviceId}/history`);
      if (!response.ok) {
        throw new Error(`Failed with status ${response.status}`);
      }

      const data = (await response.json()) as TelemetryPoint[];
      setHistoricalData(data);
      setHistoryStatus(`Loaded ${data.length} historical points`);
    } catch (error) {
      console.error('History fetch failed', error);
      setHistoryStatus('Failed to load historical data');
    }
  };

  const deviceRows = Object.values(devices).sort((a, b) => b.lastSeen - a.lastSeen);

  return (
    <div className="dashboard">
      <header>
        <h1>IoT Monitoring Dashboard</h1>
        <p className={`connection ${connectionState}`}>Connection: {connectionState}</p>
      </header>

      <section className="grid">
        <article className="card">
          <h2>Devices</h2>
          <ul className="device-list">
            {deviceRows.length === 0 && <li>No devices observed yet.</li>}
            {deviceRows.map((device) => {
              const online = Date.now() - device.lastSeen < ONLINE_THRESHOLD_MS;
              return (
                <li key={device.deviceId}>
                  <button
                    type="button"
                    className={selectedDeviceId === device.deviceId ? 'selected' : ''}
                    onClick={() => setSelectedDeviceId(device.deviceId)}
                  >
                    <strong>{device.deviceId}</strong>
                    <span>{device.sensorType}</span>
                    <span>{device.latestValue}</span>
                    <span className={online ? 'online' : 'offline'}>{online ? 'online' : 'offline'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </article>

        <article className="card wide">
          <h2>Live Telemetry</h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={selectedSeries}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleTimeString()} />
              <YAxis />
              <Tooltip labelFormatter={(label) => new Date(label).toLocaleString()} />
              <Legend />
              <Line dataKey="value" dot={false} type="monotone" stroke="#2563eb" />
            </LineChart>
          </ResponsiveContainer>
        </article>

        <article className="card">
          <h2>Device Control</h2>
          <form onSubmit={publishCommand}>
            <textarea
              value={commandPayload}
              onChange={(event) => setCommandPayload(event.target.value)}
              rows={6}
            />
            <button type="submit" disabled={!selectedDeviceId || connectionState !== 'connected'}>
              Send command
            </button>
          </form>
        </article>

        <article className="card">
          <h2>Historical Data</h2>
          <button type="button" onClick={fetchHistory} disabled={!selectedDeviceId || !apiBaseUrl}>
            Load history
          </button>
          <p>{historyStatus}</p>
          <pre>{JSON.stringify(historicalData.slice(-5), null, 2)}</pre>
        </article>
      </section>
    </div>
  );
}
