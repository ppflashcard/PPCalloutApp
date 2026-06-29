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
  let effects = null;

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

  function getEffectMode(theme) {
    if (theme === "rain") {
      return "rain";
    }
    if (theme === "snow") {
      return "snow";
    }
    if (theme === "cold") {
      return "snow-light";
    }
    return null;
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-bg-theme", theme);
    if (effects) {
      effects.setMode(getEffectMode(theme));
    }
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

  class BackgroundEffects {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.width = 0;
      this.height = 0;
      this.mode = null;
      this.particles = [];
      this.raf = null;
      this.tick = 0;
      this.resize = this.resize.bind(this);
      this.animate = this.animate.bind(this);
      window.addEventListener("resize", this.resize);
      this.resize();
    }

    resize() {
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      if (this.mode) {
        this.buildParticles(this.mode);
      }
    }

    setMode(mode) {
      if (this.mode === mode) {
        return;
      }
      this.mode = mode;
      this.particles = [];
      this.tick = 0;

      if (!mode) {
        this.stop();
        return;
      }

      this.buildParticles(mode);
      this.start();
    }

    buildParticles(mode) {
      const area = this.width * this.height;

      if (mode === "rain") {
        const count = Math.min(420, Math.max(120, Math.floor(area / 9000)));
        this.particles = Array.from({ length: count }, () => ({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          length: 10 + Math.random() * 16,
          speed: 10 + Math.random() * 14,
          width: 1 + Math.random() * 0.8,
          opacity: 0.18 + Math.random() * 0.35,
        }));
        return;
      }

      const density = mode === "snow-light" ? 14000 : 9000;
      const count = Math.min(220, Math.max(50, Math.floor(area / density)));
      this.particles = Array.from({ length: count }, () => ({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        radius: mode === "snow-light" ? 1 + Math.random() * 2 : 1.5 + Math.random() * 3.5,
        speed: mode === "snow-light" ? 0.4 + Math.random() * 0.8 : 0.6 + Math.random() * 1.2,
        drift: 0.3 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
        opacity: mode === "snow-light" ? 0.35 + Math.random() * 0.35 : 0.45 + Math.random() * 0.45,
      }));
    }

    start() {
      if (this.raf) {
        return;
      }
      this.raf = window.requestAnimationFrame(this.animate);
    }

    stop() {
      if (this.raf) {
        window.cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      this.ctx.clearRect(0, 0, this.width, this.height);
    }

    drawRain() {
      this.ctx.strokeStyle = "rgba(174, 197, 235, 0.55)";
      this.ctx.lineCap = "round";

      this.particles.forEach((drop) => {
        drop.y += drop.speed;
        drop.x -= drop.speed * 0.08;

        if (drop.y > this.height + drop.length) {
          drop.y = -drop.length;
          drop.x = Math.random() * this.width;
        }
        if (drop.x < -20) {
          drop.x = this.width + 20;
        }

        this.ctx.globalAlpha = drop.opacity;
        this.ctx.lineWidth = drop.width;
        this.ctx.beginPath();
        this.ctx.moveTo(drop.x, drop.y);
        this.ctx.lineTo(drop.x - 4, drop.y + drop.length);
        this.ctx.stroke();
      });

      this.ctx.globalAlpha = 1;
    }

    drawSnow() {
      this.tick += 1;

      this.particles.forEach((flake) => {
        flake.y += flake.speed;
        flake.x += Math.sin(this.tick * 0.01 + flake.phase) * flake.drift;

        if (flake.y > this.height + flake.radius) {
          flake.y = -flake.radius;
          flake.x = Math.random() * this.width;
        }
        if (flake.x > this.width + flake.radius) {
          flake.x = -flake.radius;
        }
        if (flake.x < -flake.radius) {
          flake.x = this.width + flake.radius;
        }

        this.ctx.globalAlpha = flake.opacity;
        this.ctx.fillStyle = "#ffffff";
        this.ctx.beginPath();
        this.ctx.arc(flake.x, flake.y, flake.radius, 0, Math.PI * 2);
        this.ctx.fill();
      });

      this.ctx.globalAlpha = 1;
    }

    animate() {
      this.ctx.clearRect(0, 0, this.width, this.height);

      if (this.mode === "rain") {
        this.drawRain();
      } else if (this.mode === "snow" || this.mode === "snow-light") {
        this.drawSnow();
      }

      this.raf = window.requestAnimationFrame(this.animate);
    }
  }

  function initEffects() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.id = "bg-effects-canvas";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    effects = new BackgroundEffects(canvas);
  }

  function boot() {
    initEffects();
    initThemePicker();
    const manualOnLoad = getManualPreference();
    const initialTheme = manualOnLoad && manualOnLoad !== "auto" ? manualOnLoad : getTimeTheme();
    setTheme(initialTheme);
    void updateTheme();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.setInterval(updateTheme, CHECK_MS);
})();
