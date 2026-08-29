/* global browser */

// Classic script, not a module. The popup's main.tsx is type=module and in
// `npm run dev` that graph takes seconds; this file is copied from public/
// and runs as soon as the HTML parser hits it, so the gear works on the
// "Reading tabs…" screen. preventDefault keeps the href from also opening
// a second tab once this listener is attached.
const gear = document.getElementById("options");
if (gear) {
  gear.addEventListener("click", (event) => {
    event.preventDefault();
    void browser.runtime.openOptionsPage();
  });
}
