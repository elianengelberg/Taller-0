/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#FBEDE4",
          100: "#F6DCCB",
          200: "#EFC0A3",
          300: "#E8A489",
          400: "#E08A63",
          500: "#D97757",
          600: "#C15F3F",
          700: "#9C4B32",
          800: "#7A3B28",
          900: "#5C2D1F",
        },
        // Warm near-black to near-white neutral scale used for every
        // surface and text color in the (dark) UI: 950 is the page
        // background, 50 is near-white text.
        ink: {
          50: "#FAF8F5",
          100: "#ECE8E2",
          200: "#D6D1C9",
          300: "#B3AEA6",
          400: "#8F8A83",
          500: "#6B6660",
          600: "#46423E",
          700: "#322F2C",
          800: "#242220",
          900: "#1B1A18",
          950: "#131211",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
      },
      boxShadow: {
        soft: "0 8px 24px -8px rgba(20, 17, 15, 0.18)",
      },
    },
  },
  plugins: [],
};
