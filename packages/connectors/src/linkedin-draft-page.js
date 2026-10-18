// Serialized into the activated LinkedIn page with Function.prototype.toString(),
// so it stays plain JS: no syntax a transform would rewrite, no outer bindings.
/** Serialized as one closed function; never clicks Send/Post or presses Enter. */
export async function fillLinkedInDraft(input) {
  function fail(message) {
    throw new Error(`LinkedIn draft: ${message}`);
  }
  if (location.href !== input.url)
    fail("The activated page is not the requested draft target");
  const visible = (element) =>
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  let editor;
  if (input.kind === "prepare_message") {
    const selected = [
      ...document.querySelectorAll(
        '.msg-conversation-listitem--active a[href*="/messaging/thread/"], a[aria-current="page"][href*="/messaging/thread/"]'
      ),
    ].filter(
      (link) =>
        visible(link) &&
        new URL(link.href).pathname === new URL(input.url).pathname
    );
    if (selected.length !== 1)
      fail("The selected conversation does not match the requested recipient");
    const threads = [...document.querySelectorAll(".msg-thread")].filter(
      visible
    );
    if (threads.length !== 1) fail("Exactly one conversation must be open");
    const editors = [
      ...threads[0].querySelectorAll(
        '.msg-form [contenteditable="true"][role="textbox"]'
      ),
    ].filter(visible);
    if (editors.length !== 1)
      fail("The conversation message composer is unavailable");
    editor = editors[0];
    if (
      threads[0].querySelector(
        '.msg-form__attachment, .msg-form__attachments [data-attachment-id], input[type="file"]:disabled'
      )
    ) {
      fail("The conversation already has an attachment draft");
    }
  } else if (input.kind === "prepare_post") {
    if (document.querySelector('[role="dialog"] [contenteditable="true"]'))
      fail("A composer is already open; finish or close it first");
    const buttons = [
      ...document.querySelectorAll(
        'button, a[href="https://www.linkedin.com/preload/sharebox/?"]'
      ),
    ].filter(
      (button) =>
        visible(button) && button.textContent?.trim() === "Start a post"
    );
    if (buttons.length !== 1)
      fail("The personal post composer entry point is unavailable");
    buttons[0].click();
    for (let attempt = 0; attempt < 40; attempt++) {
      const editors = [
        ...document.querySelectorAll(
          '[role="dialog"] [contenteditable="true"][role="textbox"], [role="dialog"] .ql-editor[contenteditable="true"]'
        ),
      ].filter(visible);
      if (editors.length === 1) {
        editor = editors[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!editor) fail("The personal post composer did not open");
    const dialog = editor.closest('[role="dialog"]');
    if (
      !dialog ||
      dialog.querySelector('input[type="file"]:disabled, [data-attachment-id]')
    )
      fail("The post composer is not an empty text draft");
  } else fail("Unsupported draft action");
  if (!editor || location.href !== input.url)
    fail("The activated target changed");
  if (
    (editor.textContent ?? "").trim() ||
    editor.querySelector("img,video,audio,[contenteditable=false]")
  )
    fail("The composer already contains a draft");
  editor.focus();
  if (!document.execCommand("insertText", false, input.body))
    fail("The browser could not fill the draft");
  const normalized = (value) => value.replace(/\r\n/g, "\n").trim();
  if (
    normalized(editor.innerText ?? editor.textContent ?? "") !==
    normalized(input.body)
  )
    fail("The draft text could not be verified; review the composer");
  return {
    prepared: true,
    submitted: false,
    url: input.url,
    message:
      input.kind === "prepare_message"
        ? "Draft ready. Review it and click Send in LinkedIn."
        : "Draft ready. Review it and click Post in LinkedIn.",
  };
}
