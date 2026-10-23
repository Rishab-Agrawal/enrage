/** Messages the owner on Telegram once both TELEGRAM_* variables are set, as only the deployed server's are. */
export async function tell(text: string): Promise<void> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  })
    .then((response) => response.ok || console.warn('Telegram:', response.status))
    .catch((error) => console.warn('Telegram failed:', error));
}

const alerted = new Map<string, number>();

/** A problem, told at most once every 10 minutes per `about`: an outage would otherwise send one a player turn. */
export async function alert(about: string, detail = ''): Promise<void> {
  console.error(about, detail);
  if (Date.now() - (alerted.get(about) ?? -Infinity) < 10 * 60_000) return;
  alerted.set(about, Date.now());
  await tell(`⚠️ ${about}${detail && `: ${detail}`}`);
}
