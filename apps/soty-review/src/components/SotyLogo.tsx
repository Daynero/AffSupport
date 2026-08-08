import sotyLogo from '../assets/soty-logo.png';

export function SotyLogo() {
  return (
    <span className="soty-logo" aria-label="Soty">
      <img className="soty-logo-image" src={sotyLogo} alt="" />
    </span>
  );
}
