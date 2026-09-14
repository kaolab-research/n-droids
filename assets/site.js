/* n-droids site — small progressive-enhancement layer.
   Everything here is optional: the site reads fine with JavaScript disabled. */
(function () {
  "use strict";

  /* -- Mobile navigation --------------------------------------------------- */

  function initNav() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.querySelector(".site-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
    });

    nav.addEventListener("click", function (event) {
      if (event.target.tagName === "A") {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* -- Copy-to-clipboard on code blocks ------------------------------------ */

  function initCopyButtons() {
    var blocks = document.querySelectorAll(".code-block");

    Array.prototype.forEach.call(blocks, function (block) {
      var code = block.querySelector("pre code");
      if (!code) return;

      var label = block.querySelector(".code-label");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "copy-btn";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code to clipboard");

      button.addEventListener("click", function () {
        var text = code.textContent;
        var done = function () {
          button.textContent = "Copied";
          button.classList.add("is-copied");
          window.setTimeout(function () {
            button.textContent = "Copy";
            button.classList.remove("is-copied");
          }, 1600);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, fallback);
        } else {
          fallback();
        }

        function fallback() {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "absolute";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
            done();
          } catch (err) {
            button.textContent = "Press ⌘C";
          }
          document.body.removeChild(ta);
        }
      });

      if (label) {
        label.appendChild(button);
      } else {
        var bar = document.createElement("div");
        bar.className = "code-label";
        bar.appendChild(button);
        block.insertBefore(bar, block.firstChild);
      }
    });
  }

  /* -- Minimal syntax highlighting -----------------------------------------
     Only applied to <code class="lang-*">. Operates on textContent and
     re-escapes everything it emits, so it can never inject markup.        */

  var KEYWORDS = [
    "def", "class", "import", "from", "as", "with", "return", "for", "while",
    "if", "elif", "else", "try", "except", "finally", "not", "in", "is",
    "None", "True", "False", "and", "or", "pass", "raise", "lambda", "yield",
    "await", "async", "self", "print", "assert", "global", "break", "continue",
    "export", "source", "sudo", "docker", "cd", "echo", "set", "then", "fi",
  ];

  var TOKEN_RE = new RegExp(
    "(#[^\\n]*)" +                                          // comment
      "|(\"\"\"[\\s\\S]*?\"\"\"|'''(?:[\\s\\S]*?)''')" +     // triple-quoted
      "|(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*')" + // string
      "|\\b(" + KEYWORDS.join("|") + ")\\b" +               // keyword
      "|\\b(\\d+(?:\\.\\d+)?)\\b",                          // number
    "g"
  );

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function highlight(source) {
    var out = "";
    var last = 0;
    var match;

    TOKEN_RE.lastIndex = 0;
    while ((match = TOKEN_RE.exec(source)) !== null) {
      out += escapeHtml(source.slice(last, match.index));

      var cls = match[1]
        ? "tok-com"
        : match[2] || match[3]
          ? "tok-str"
          : match[4]
            ? "tok-key"
            : "tok-num";

      out += '<span class="' + cls + '">' + escapeHtml(match[0]) + "</span>";
      last = match.index + match[0].length;
    }
    out += escapeHtml(source.slice(last));
    return out;
  }

  function initHighlighting() {
    var targets = document.querySelectorAll(
      "code.lang-python, code.lang-bash, code.lang-yaml, code.lang-text"
    );
    Array.prototype.forEach.call(targets, function (el) {
      el.innerHTML = highlight(el.textContent);
    });
  }

  /* -- Boot ---------------------------------------------------------------- */

  function boot() {
    initNav();
    initHighlighting();
    initCopyButtons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
