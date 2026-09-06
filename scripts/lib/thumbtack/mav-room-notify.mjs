import fs from 'node:fs';

const DEFAULT_ENV = 'C:\\Workspace\\Active\\Mav-Room\\.mav-room\\runtime.env';
const DEFAULT_FABRIC = 'https://mav-fabric.tailf72e3f.ts.net:18920';
const DEFAULT_ROOM = 'mav-room';

function readEnvFile(filePath) {
  const values = {};
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) values[match[1]] = match[2].trim();
    }
  } catch {
    return values;
  }
  return values;
}

function clip(text, max) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

export function formatLeadNotice({ concern, reply } = {}) {
  const what = clip(concern, 280) || 'a new job';
  const said = clip(reply, 800) || '(no visible reply)';
  return `New Thumbtack lead: ${what}\n\nMav replied: ${said}`;
}

export async function notifyMavRoomLead({ concern, reply, fetchImpl = fetch } = {}) {
  const fileEnv = readEnvFile(process.env.MAV_ROOM_ENV_FILE || DEFAULT_ENV);
  const token = process.env.MAV_FABRIC_MAVH_CREDENTIAL || fileEnv.MAV_FABRIC_MAVH_CREDENTIAL || '';
  if (!token) return { sent: false, reason: 'not-configured' };
  const fabric = (process.env.MAV_FABRIC_URL || fileEnv.MAV_FABRIC_URL || DEFAULT_FABRIC).replace(/\/$/, '');
  const roomId = process.env.MAV_ROOM_ID || fileEnv.MAV_ROOM_ID || DEFAULT_ROOM;
  const text = formatLeadNotice({ concern, reply });
  const res = await fetchImpl(`${fabric}/api/rooms/${encodeURIComponent(roomId)}/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'message', payload: { text } }),
  });
  if (!res.ok) throw new Error(`Mav-Room notify failed (HTTP ${res.status})`);
  return { sent: true };
}
