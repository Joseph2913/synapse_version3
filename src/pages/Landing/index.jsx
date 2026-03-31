import LandingNav from '../../components/LandingNav/LandingNav';
import LandingHero from '../../components/LandingHero/LandingHero';
import LandingProblem from '../../components/LandingProblem/LandingProblem';
import LandingSolution from '../../components/LandingSolution/LandingSolution';
import './Landing.css';

export default function Landing() {
  return (
    <div className="landing-page">
      <LandingNav />
      <LandingHero />
      <LandingProblem />
      <LandingSolution />
    </div>
  );
}
