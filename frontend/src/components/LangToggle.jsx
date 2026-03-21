import { useTranslation } from 'react-i18next';

export default function LangToggle() {
  const { i18n } = useTranslation();

  const set = (lang) => {
    i18n.changeLanguage(lang);
    localStorage.setItem('kis_lang', lang);
  };

  return (
    <div className="lang-toggle">
      <button
        className={i18n.language === 'en' ? 'active' : ''}
        onClick={() => set('en')}
        aria-label="Switch to English"
      >
        EN
      </button>
      <button
        className={i18n.language === 'es' ? 'active' : ''}
        onClick={() => set('es')}
        aria-label="Cambiar a español"
      >
        ES
      </button>
    </div>
  );
}
