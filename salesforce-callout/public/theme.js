(function applyAmbientBackgroundTheme() {
  const CHECK_MS = 15 * 60 * 1000;
  const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
  const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

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
    if (typeof weatherCode === "number" && RAIN_CODES.has(weatherCode)) {
      return "rain";
    }
    if (
      (typeof weatherCode === "number" && SNOW_CODES.has(weatherCode)) ||
      (typeof tempC === "number" && tempC <= 5)
    ) {
      return "cold";
    }
    return null;
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-bg-theme", theme);
  }

  function resolveTheme() {
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
    await refreshWeatherTheme();
    setTheme(resolveTheme());
  }

  updateTheme();
  window.setInterval(updateTheme, CHECK_MS);
})();
