import { readFileSync } from 'node:fs';
const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
const manifest = {
    manifest_version: 3,
    name: 'Bale WebRTC Peer Link',
    version: packageJson.version,
    description: 'Captures Bale WebRTC TURN credentials and helps connect two extension users via a WebRTC DataChannel.',
    host_permissions: ['https://web.bale.ai/*'],
    permissions: ['storage', 'tabs'],
    background: {
        service_worker: 'background.js',
        type: 'module',
    },
    action: {
        default_popup: 'src/popup/index.html',
    },
    content_scripts: [
        {
            matches: ['https://web.bale.ai/*'],
            js: ['content/bale.js'],
            run_at: 'document_start',
            all_frames: true,
        },
    ],
    web_accessible_resources: [
        {
            resources: ['injected/bale-webrtc-hook.js'],
            matches: ['https://web.bale.ai/*'],
        },
    ],
};
export default manifest;
