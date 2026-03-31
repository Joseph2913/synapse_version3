import { useState, useEffect } from 'react';
import './LandingNav.css';

export default function LandingNav() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    function handleScroll() {
      // Switch to dark variant when we're past the hero section (~100vh)
      setIsDark(window.scrollY > window.innerHeight * 0.8);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <nav className={`lp-nav${isDark ? ' is-dark' : ''}`}>
      <div className="lp-nav-bar">
        <a className="lp-nav-brand" href="/landing">
          <span className="lp-nav-brand-dot" />
          Synapse
        </a>

        <div className="lp-nav-links">
          <span className="lp-nav-link">Product</span>
          <span className="lp-nav-link">Use Cases</span>
          <span className="lp-nav-link">About</span>
          <span className="lp-nav-link">Docs</span>
        </div>

        <button className="lp-nav-cta" type="button">
          Join Waitlist
        </button>
      </div>
    </nav>
  );
}
