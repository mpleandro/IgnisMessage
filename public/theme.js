// Tema claro/escuro. Carregado no <head> para aplicar antes da página aparecer (sem piscar).
// Sem escolha salva, segue o sistema. A chave não começa com "disp_" para o botão "Limpar" não apagá-la.
(function () {
  var KEY = 'disparador_theme';
  var root = document.documentElement;
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function system() { return window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
  function apply(t) { root.setAttribute('data-theme', t); }
  apply(saved() || system());

  function label(btn) {
    var light = root.getAttribute('data-theme') === 'light';
    btn.setAttribute('aria-pressed', String(light));
    btn.title = light ? 'Mudar para o modo escuro' : 'Mudar para o modo claro';
    btn.querySelector('.knob').textContent = light ? '☀' : '☾';
    btn.querySelector('.lbl').textContent = light ? 'Claro' : 'Escuro';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var host = document.querySelector('.nav-right');
    if (!host) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-label', 'Alternar modo claro/escuro');
    btn.innerHTML = '<span class="track"><span class="knob"></span></span><span class="lbl"></span>';
    host.insertBefore(btn, host.firstChild);
    label(btn);
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      label(btn);
    });
    if (window.matchMedia) {
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
        if (!saved()) { apply(system()); label(btn); }
      });
    }
  });
})();
