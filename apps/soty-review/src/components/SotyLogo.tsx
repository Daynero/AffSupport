import sotyLogoDark from '../assets/soty-header-logo-dark.svg';
import sotyLogoLight from '../assets/soty-header-logo-light.svg';

export function SotyLogo() {
  return (
    <span className="soty-logo" aria-label="Soty">
      <img className="soty-logo-image soty-logo-image-light" src={sotyLogoLight} alt="" />
      <img
        className="soty-logo-image soty-logo-image-dark"
        src={sotyLogoDark}
        alt=""
        aria-hidden="true"
      />
    </span>
  );
}
