/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0f17",
        panel: "#121826",
        line: "#1f2a3d",
        accent: "#22d3ee",
        gold: "#fbbf24",
      },
    },
  },
  plugins: [],
};
