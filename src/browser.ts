import { execFileSync } from 'node:child_process';

export function openBrowser(url: string, run = execFileSync, platform = process.platform) {
  if (platform === 'darwin') run('open', [url], { stdio: 'ignore' });
  else if (platform === 'win32') run('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' });
  else run('xdg-open', [url], { stdio: 'ignore' });
}
