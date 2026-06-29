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
  let particleEngine = null;
  let reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function getTimeTheme(date = new Date()) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 8) return "dawn";
    if (hour >= 8 && hour < 17) return "day";
    if (hour >= 17 && hour < 20) return "dusk";
    return "night";
  }

  function getWeatherTheme(tempC, weatherCode) {
    if (typeof weatherCode === "number" && SNOW_CODES.has(weatherCode)) return "snow";
    if (typeof weatherCode === "number" && RAIN_CODES.has(weatherCode)) return "rain";
    if (typeof tempC === "number" && tempC <= 5) return "cold";
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

  function getVisualEffect(theme) {
    switch (theme) {
      case "day":
        return "sun";
      case "dawn":
        return "sun-dawn";
      case "dusk":
        return "sun-dusk";
      case "night":
        return "moon";
      case "rain":
        return "rain";
      case "snow":
        return "snow";
      case "cold":
        return "snow-light";
      default:
        return "none";
    }
  }

  function getParticleMode(visualEffect) {
    if (visualEffect === "rain") return "rain";
    if (visualEffect === "snow") return "snow";
    if (visualEffect === "snow-light") return "snow-light";
    if (visualEffect === "moon") return "stars";
    return null;
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-bg-theme", theme);
    const visualEffect = getVisualEffect(theme);
    document.documentElement.setAttribute("data-bg-effect", visualEffect);
    if (particleEngine) {
      particleEngine.setMode(getParticleMode(visualEffect));
    }
    const select = document.getElementById("bg-theme-select");
    if (select instanceof HTMLSelectElement) {
      select.value = getManualPreference() || "auto";
    }
  }

  function resolveAutoTheme() {
    return weatherTheme ?? getTimeTheme();
  }

  async function refreshWeatherTheme() {
    if (!navigator.geolocation) return;

    const now = Date.now();
    if (now - weatherCheckedAt < WEATHER_TTL_MS) return;
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
    if (!mount) return;

    const wrapper = document.createElement("div");
    wrapper.className = "theme-picker";
    wrapper.innerHTML = `
      <label class="theme-picker-label" for="bg-theme-select">Background</label>
      <select id="bg-theme-select" class="theme-picker-select" aria-label="Choose background theme">
        ${THEME_OPTIONS.map((option) => `<option value="${option.id}">${option.label}</option>`).join("")}
      </select>
    `;
    mount.appendChild(wrapper);

    const select = wrapper.querySelector("#bg-theme-select");
    if (!(select instanceof HTMLSelectElement)) return;

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

  class ParticleEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
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
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.floor(this.width * this.dpr);
      this.canvas.height = Math.floor(this.height * this.dpr);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.mode) this.buildParticles(this.mode);
    }

    setMode(mode) {
      this.mode = mode;
      this.particles = [];
      this.tick = 0;

      if (!mode) {
        this.stop();
        return;
      }

      this.buildParticles(mode);
      if (reduceMotion) {
        this.drawFrame();
        return;
      }
      this.start();
    }

    buildParticles(mode) {
      const area = this.width * this.height;

      if (mode === "rain") {
        const count = Math.min(550, Math.max(180, Math.floor(area / 5500)));
        this.particles = Array.from({ length: count }, () => ({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          length: 14 + Math.random() * 22,
          speed: 14 + Math.random() * 18,
          width: 1.2 + Math.random() * 1.4,
          opacity: 0.45 + Math.random() * 0.45,
        }));
        return;
      }

      if (mode === "stars") {
        const count = Math.min(160, Math.max(60, Math.floor(area / 12000)));
        this.particles = Array.from({ length: count }, () => ({
          x: Math.random() * this.width,
          y: Math.random() * this.height * 0.75,
          radius: 0.6 + Math.random() * 1.6,
          twinkle: Math.random() * Math.PI * 2,
          opacity: 0.35 + Math.random() * 0.55,
        }));
        return;
      }

      const density = mode === "snow-light" ? 11000 : 7000;
      const count = Math.min(280, Math.max(80, Math.floor(area / density)));
      this.particles = Array.from({ length: count }, () => ({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        radius: mode === "snow-light" ? 1.5 + Math.random() * 2.5 : 2 + Math.random() * 4,
        speed: mode === "snow-light" ? 0.7 + Math.random() * 1.1 : 1 + Math.random() * 1.8,
        drift: 0.5 + Math.random() * 1.2,
        phase: Math.random() * Math.PI * 2,
        opacity: 0.65 + Math.random() * 0.35,
      }));
    }

    start() {
      if (this.raf) return;
      this.raf = window.requestAnimationFrame(this.animate);
    }

    stop() {
      if (this.raf) {
        window.cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      this.ctx.clearRect(0, 0, this.width, this.height);
    }

    drawFrame() {
      this.ctx.clearRect(0, 0, this.width, this.height);
      if (this.mode === "rain") this.drawRain(false);
      else if (this.mode === "snow" || this.mode === "snow-light") this.drawSnow(false);
      else if (this.mode === "stars") this.drawStars(false);
    }

    drawRain(animate = true) {
      this.ctx.strokeStyle = "rgba(147, 197, 253, 0.95)";
      this.ctx.lineCap = "round";
      this.particles.forEach((drop) => {
        if (animate) {
          drop.y += drop.speed;
          drop.x -= drop.speed * 0.12;
          if (drop.y > this.height + drop.length) {
            drop.y = -drop.length;
            drop.x = Math.random() * this.width;
          }
          if (drop.x < -30) drop.x = this.width + 30;
        }
        this.ctx.globalAlpha = drop.opacity;
        this.ctx.lineWidth = drop.width;
        this.ctx.beginPath();
        this.ctx.moveTo(drop.x, drop.y);
        this.ctx.lineTo(drop.x - 5, drop.y + drop.length);
        this.ctx.stroke();
      });
      this.ctx.globalAlpha = 1;
    }

    drawSnow(animate = true) {
      this.tick += 1;
      this.particles.forEach((flake) => {
        if (animate) {
          flake.y += flake.speed;
          flake.x += Math.sin(this.tick * 0.012 + flake.phase) * flake.drift;
          if (flake.y > this.height + flake.radius) {
            flake.y = -flake.radius;
            flake.x = Math.random() * this.width;
          }
        }
        this.ctx.globalAlpha = flake.opacity;
        this.ctx.fillStyle = "#ffffff";
        this.ctx.beginPath();
        this.ctx.arc(flake.x, flake.y, flake.radius, 0, Math.PI * 2);
        this.ctx.fill();
      });
      this.ctx.globalAlpha = 1;
    }

    drawStars(animate = true) {
      this.tick += 1;
      this.particles.forEach((star) => {
        const pulse = animate
          ? 0.55 + Math.sin(this.tick * 0.03 + star.twinkle) * 0.35
          : star.opacity;
        this.ctx.globalAlpha = star.opacity * pulse;
        this.ctx.fillStyle = "#ffffff";
        this.ctx.beginPath();
        this.ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        this.ctx.fill();
      });
      this.ctx.globalAlpha = 1;
    }

    animate() {
      this.ctx.clearRect(0, 0, this.width, this.height);
      if (this.mode === "rain") this.drawRain(true);
      else if (this.mode === "snow" || this.mode === "snow-light") this.drawSnow(true);
      else if (this.mode === "stars") this.drawStars(true);
      this.raf = window.requestAnimationFrame(this.animate);
    }
  }

  function initEffectsLayer() {
    if (document.getElementById("bg-effects-layer")) return;

    const layer = document.createElement("div");
    layer.id = "bg-effects-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML = `
      <div class="bg-scene-sun"></div>
      <div class="bg-scene-moon"></div>
      <div class="bg-scene-clouds">
        <span class="bg-cloud bg-cloud-1"></span>
        <span class="bg-cloud bg-cloud-2"></span>
        <span class="bg-cloud bg-cloud-3"></span>
      </div>
      <canvas id="bg-effects-canvas"></canvas>
    `;
    document.body.prepend(layer);

    const canvas = layer.querySelector("#bg-effects-canvas");
    if (canvas instanceof HTMLCanvasElement) {
      particleEngine = new ParticleEngine(canvas);
    }
  }

  function boot() {
    initEffectsLayer();
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
