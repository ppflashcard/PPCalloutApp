(function applyAmbientBackgroundTheme() {
  const CHECK_MS = 15 * 60 * 1000;
  const STORAGE_KEY = "sf-bg-theme-preference";
  const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
  const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

  const THEME_OPTIONS = [
    { id: "auto", label: "Auto" },
    { id: "day", label: "Day" },
    { id: "dawn", label: "Dawn" },
    { id: "dusk", label: "Dusk" },
    { id: "night", label: "Night" },
    { id: "rain", label: "Rainy" },
    { id: "snow", label: "Snow" },
    { id: "cold", label: "Cold" },
  ];

  let weatherTheme = null;
  let weatherCheckedAt = 0;
  const WEATHER_TTL_MS = 30 * 60 * 1000;

  function getTimeTheme(date = new Date()) {
    const hour = date.getHours();

    if (hour >= 5 && hour < 8) {
      return "dawn";
    }
    if (hour >= 8 && hour < 17) {
      return "day";
    }
    if (hour >= 17 && hour < 20) {
      return "dusk";
    }
    return "night";
  }

  function getWeatherTheme(tempC, weatherCode) {
    if (typeof weatherCode === "number" && SNOW_CODES.has(weatherCode)) {
      return "snow";
    }
    if (typeof weatherCode === "number" && RAIN_CODES.has(weatherCode)) {
      return "rain";
    }
    if (typeof tempC === "number" && tempC <= 5) {
      return "cold";
    }
    return null;
  }

  function getManualPreference() {
    return localStorage.getItem(STORAGE_KEY);
  }

  function setManualPreference(value) {
    if (!value || value === "auto") {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, value);
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-bg-theme", theme);
    const select = document.getElementById("bg-theme-select");
    if (select instanceof HTMLSelectElement) {
      const preference = getManualPreference() || "auto";
      select.value = preference;
    }
  }

  function resolveAutoTheme() {
    return weatherTheme ?? getTimeTheme();
  }

  async function refreshWeatherTheme() {
    if (!navigator.geolocation) {
      return;
    }

    const now = Date.now();
    if (now - weatherCheckedAt < WEATHER_TTL_MS) {
      return;
    }

    weatherCheckedAt = now;

    await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          try {
            const { latitude, longitude } = position.coords;
            const url =
              "https://api.open-meteo.com/v1/forecast?" +
              `latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`;

            const response = await fetch(url);
            if (!response.ok) {
              resolve();
              return;
            }

            const payload = await response.json();
            weatherTheme = getWeatherTheme(
              payload.current?.temperature_2m,
              payload.current?.weather_code,
            );
          } catch {
            // keep time-based theme
          }
          resolve();
        },
        () => resolve(),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: WEATHER_TTL_MS },
      );
    });
  }

  async function updateTheme() {
    const manual = getManualPreference();
    if (manual && manual !== "auto") {
      setTheme(manual);
      return;
    }

    await refreshWeatherTheme();
    setTheme(resolveAutoTheme());
  }

  function initThemePicker() {
    const mount = document.getElementById("theme-picker-mount");
    if (!mount) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "theme-picker";
    wrapper.innerHTML = `
      <label class="theme-picker-label" for="bg-theme-select">Background</label>
      <select id="bg-theme-select" class="theme-picker-select" aria-label="Choose background theme">
        ${THEME_OPTIONS.map(
          (option) => `<option value="${option.id}">${option.label}</option>`,
        ).join("")}
      </select>
    `;

    mount.appendChild(wrapper);

    const select = wrapper.querySelector("#bg-theme-select");
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }

    select.value = getManualPreference() || "auto";

    select.addEventListener("change", () => {
      setManualPreference(select.value);
      if (select.value === "auto") {
        void updateTheme();
        return;
      }
      setTheme(select.value);
    });
  }

  const manualOnLoad = getManualPreference();
  setTheme(manualOnLoad && manualOnLoad !== "auto" ? manualOnLoad : getTimeTheme());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initThemePicker);
  } else {
    initThemePicker();
  }

  void updateTheme();
  window.setInterval(updateTheme, CHECK_MS);
})();
