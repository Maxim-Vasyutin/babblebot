/**
 * Экранирование пользовательского текста перед вставкой в HTML-сообщение
 * (parse_mode=HTML). Обязательно для полей car, landmark, username.
 *
 * См. SPEC.md, Блок 5 — «Экранирование HTML».
 */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
