(function () {
  let lastVersion = null;

  async function checkForUpdates() {
    try {
      const response = await fetch("/__dev/reload-version", { cache: "no-store" });
      if (!response.ok) {
        return;
      }

      const { version } = await response.json();
      if (lastVersion !== null && lastVersion !== version) {
        window.location.reload();
        return;
      }

      lastVersion = version;
    } catch {
      // Dev reload is optional; ignore network errors.
    }
  }

  checkForUpdates();
  window.setInterval(checkForUpdates, 1000);
})();
