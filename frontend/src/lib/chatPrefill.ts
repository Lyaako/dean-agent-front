// «Подготовить заново»: открыть чат и вставить текст в поле сообщения, без отправки (Р4)
const EVENT = "deanery:chat-prefill";
export const prefillChat = (text: string) => window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: text }));
export const onChatPrefill = (fn: (text: string) => void) => {
  const h = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
};
