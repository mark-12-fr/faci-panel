/* SmoothSelect — vanilla JS custom dropdown (the teacher panel's React
   SmoothSelect, backported for the static faci-panel pages).
   Usage: <select data-smooth-select ...> — on load each marked <select> is
   replaced by a styled trigger + pop-open animated list. The hidden native
   select stays in the DOM, so existing code that reads .value / fires
   change events keeps working unchanged. */
(function () {
  "use strict";

  if (window.__smoothSelectLoaded) return;
  window.__smoothSelectLoaded = true;

  var CSS = [
    ".ss-root{position:relative;display:inline-block;font-family:inherit;min-width:120px;max-width:200px;}",
    ".ss-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1.5px solid #3b82f6;border-radius:8px;padding:8px 10px;font-weight:800;font-size:0.9rem;background:#eff6ff;color:#3b82f6;cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .15s cubic-bezier(.34,1.56,.64,1),background .15s ease;}",
    ".ss-trigger:active{transform:scale(.97);}",
    ".ss-trigger.ss-empty{color:#3b82f6;opacity:.75;}",
    ".ss-trigger .ss-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}",
    ".ss-chevron{font-size:.7rem;color:#3b82f6;transition:transform .22s cubic-bezier(.34,1.56,.64,1);flex-shrink:0;}",
    ".ss-root.ss-open .ss-chevron{transform:rotate(180deg);}",
    ".ss-list{position:absolute;top:calc(100% + 6px);left:0;min-width:100%;max-width:260px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 14px 30px -8px rgba(15,23,42,.25);z-index:9999;max-height:260px;overflow-y:auto;padding:4px;transform-origin:top;animation:ssPop .2s cubic-bezier(.16,1,.3,1);}",
    "@keyframes ssPop{from{opacity:0;transform:scale(.96) translateY(-4px);}to{opacity:1;transform:scale(1) translateY(0);}}",
    ".ss-option{display:block;width:100%;text-align:left;border:none;background:none;padding:9px 10px;border-radius:7px;font-size:.85rem;font-weight:700;color:#1e293b;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent;touch-action:manipulation;opacity:0;animation:ssOptIn .18s ease forwards;transition:background .12s ease;}",
    "@keyframes ssOptIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}",
    ".ss-option:hover{background:#eff6ff;}",
    ".ss-option.ss-selected{background:#dbeafe;color:#1d4ed8;}",
    ".ss-option.ss-disabled{opacity:.45;pointer-events:none;}",
    ".ss-list::-webkit-scrollbar{width:5px;}",
    ".ss-list::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px;}",
    ".ss-native{position:absolute!important;width:1px;height:1px;opacity:0;pointer-events:none;}"
  ].join("\n");

  var styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  function isDisabledOpt(opt) {
    return opt && (opt.disabled || opt.getAttribute("aria-disabled") === "true");
  }

  function enhance(select) {
    var root = document.createElement("div");
    root.className = "ss-root";
    select.parentNode.insertBefore(root, select);

    var native = select;
    native.classList.add("ss-native");
    native.setAttribute("tabindex", "-1");
    native.setAttribute("aria-hidden", "true");
    root.appendChild(native);

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ss-trigger ss-empty";
    trigger.setAttribute("aria-haspopup", "listbox");
    var label = document.createElement("span");
    label.className = "ss-label";
    var chevron = document.createElement("i");
    chevron.className = "fa-solid fa-chevron-down ss-chevron";
    trigger.appendChild(label);
    trigger.appendChild(chevron);
    root.appendChild(trigger);

    var list = document.createElement("div");
    list.className = "ss-list";
    list.setAttribute("role", "listbox");
    list.style.display = "none";
    root.appendChild(list);

    var open = false;

    function refreshLabel() {
      var sel = native.selectedOptions && native.selectedOptions[0];
      if (sel && !sel.disabled && sel.value !== "") {
        label.textContent = sel.textContent.trim();
        trigger.classList.remove("ss-empty");
      } else {
        var ph = native.options && native.options[0] && native.options[0].value === "" ? native.options[0].textContent : "";
        label.textContent = ph || "Select…";
        trigger.classList.add("ss-empty");
      }
    }

    function buildList() {
      list.innerHTML = "";
      Array.prototype.forEach.call(native.options, function (opt, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "ss-option";
        b.setAttribute("role", "option");
        b.textContent = opt.textContent;
        if (opt.value !== "" && opt.value === native.value) b.classList.add("ss-selected");
        if (isDisabledOpt(opt)) b.classList.add("ss-disabled");
        b.style.animationDelay = Math.min(i * 18, 180) + "ms";
        b.addEventListener("click", function () {
          if (isDisabledOpt(opt)) return;
          if (native.value !== opt.value) {
            native.value = opt.value;
            native.dispatchEvent(new Event("change", { bubbles: true }));
          }
          refreshLabel();
          close();
          trigger.focus();
        });
        list.appendChild(b);
      });
    }

    function openList() {
      if (open || native.disabled) return;
      open = true;
      root.classList.add("ss-open");
      list.style.display = "block";
      list.style.animation = "none";
      void list.offsetWidth; // restart animation
      list.style.animation = "";
      buildList();
    }

    function close() {
      if (!open) return;
      open = false;
      root.classList.remove("ss-open");
      list.style.display = "none";
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (open) close();
      else openList();
    });

    document.addEventListener("click", function (e) {
      if (!root.contains(e.target)) close();
    });

    document.addEventListener("keydown", function (e) {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        trigger.focus();
      }
      if (e.key === "Enter") {
        var opts = list.querySelectorAll(".ss-option:not(.ss-disabled)");
        var idx = Array.prototype.indexOf.call(opts, document.activeElement);
        if (idx >= 0) opts[idx].click();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var opts = Array.prototype.slice.call(list.querySelectorAll(".ss-option:not(.ss-disabled)"));
        if (!opts.length) return;
        var cur = Array.prototype.indexOf.call(opts, document.activeElement);
        var next = e.key === "ArrowDown" ? cur + 1 : cur - 1;
        if (next < 0) next = opts.length - 1;
        if (next >= opts.length) next = 0;
        opts[next].focus();
      }
    });

    trigger.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openList();
        var first = list.querySelector(".ss-option:not(.ss-disabled)");
        if (first) first.focus();
      }
    });

    // Keep the custom list in sync when code adds/removes options at runtime.
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (open) buildList();
        refreshLabel();
      }).observe(native, { childList: true, subtree: true });
    }

    // Any other code changing the value should update the trigger label too.
    native.addEventListener("change", refreshLabel);

    refreshLabel();
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("select[data-smooth-select]"), enhance);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
