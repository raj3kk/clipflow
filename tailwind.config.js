/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // legacy tokens (purane pages tootenge nahi)
        ink: "#0b0f17",
        panel: "#121826",
        line: "#1f2a3d",
        accent: "#22d3ee",
        gold: "#fbbf24",
        // magic premium palette
        void: "#050310",
        abyss: "#0a0618",
        magic: "#8b5cf6",
        spell: "#d946ef",
        mana: "#22d3ee",
        stardust: "#e9d5ff",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        drift1: {
          "0%,100%": { transform: "translate(0,0) scale(1)" },
          "50%": { transform: "translate(6vw,-4vh) scale(1.15)" },
        },
        drift2: {
          "0%,100%": { transform: "translate(0,0) scale(1)" },
          "50%": { transform: "translate(-7vw,5vh) scale(0.9)" },
        },
        drift3: {
          "0%,100%": { transform: "translate(0,0) scale(1)" },
          "50%": { transform: "translate(4vw,6vh) scale(1.2)" },
        },
        floaty: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
        shimmer: {
          "0%": { transform: "translateX(-120%) skewX(-18deg)" },
          "100%": { transform: "translateX(240%) skewX(-18deg)" },
        },
        "pulse-glow": {
          "0%,100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        twinkle: {
          "0%,100%": { opacity: "0.15", transform: "scale(0.8)" },
          "50%": { opacity: "0.9", transform: "scale(1.15)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.45s cubic-bezier(0.22,1,0.36,1) both",
        drift1: "drift1 22s ease-in-out infinite",
        drift2: "drift2 26s ease-in-out infinite",
        drift3: "drift3 30s ease-in-out infinite",
        floaty: "floaty 5s ease-in-out infinite",
        shimmer: "shimmer 2.8s ease-in-out infinite",
        "pulse-glow": "pulse-glow 2.4s ease-in-out infinite",
        twinkle: "twinkle 3.5s ease-in-out infinite",
      },
      boxShadow: {
        magic: "0 0 24px -6px rgba(139,92,246,0.55), 0 0 48px -12px rgba(217,70,239,0.35)",
        "magic-sm": "0 0 14px -4px rgba(139,92,246,0.6)",
      },
    },
  },
  plugins: [],
};
