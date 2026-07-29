import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./locales/zh.json";
import en from "./locales/en.json";

// 启动时读取上次选择的语言，默认中文
const saved = localStorage.getItem("lang");

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: saved || "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

export default i18n;
