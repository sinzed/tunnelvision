import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

const manifest = {
  manifest_version: 3,
  name: 'Bale WebRTC Peer Link',
  version: packageJson.version,
  description:
    'Captures WebRTC ICE (STUN/TURN) from Bale, Google Meet, and Telegram Web; peer link via WebRTC DataChannel.',
  host_permissions: ['https://web.bale.ai/*', 'https://meet.google.com/*', 'https://web.telegram.org/*'],
  permissions: ['storage', 'tabs', 'offscreen'],
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  action: {
    default_popup: 'src/popup/index.html',
  },
  content_scripts: [
    {
      matches: ['https://web.bale.ai/*', 'https://meet.google.com/*', 'https://web.telegram.org/*'],
      js: ['content/bale.js'],
      run_at: 'document_start',
      all_frames: true,
    },
  ],
  web_accessible_resources: [
    {
      resources: ['injected/bale-webrtc-hook.js'],
      matches: ['https://web.bale.ai/*', 'https://meet.google.com/*', 'https://web.telegram.org/*'],
    },
  ],
};

export default manifest;
