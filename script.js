  // ハンバーガーメニュー
  function toggleNav(){
    const isOpen = document.getElementById('navlinks').classList.toggle('open');
    document.getElementById('hamburger').classList.toggle('open');
    document.body.style.overflow = isOpen ? 'hidden' : '';
  }
  function closeNav(){
    document.getElementById('hamburger').classList.remove('open');
    document.getElementById('navlinks').classList.remove('open');
    document.body.style.overflow = '';
  }

  const header = document.getElementById('siteHeader');
  const hbg = document.getElementById('hamburger');
  window.addEventListener('scroll', () => {
    const solid = window.scrollY > 40;
    header.classList.toggle('solid', solid);
    if(hbg) hbg.classList.toggle('bg-solid', solid);
  });

  const reveals = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('in'); });
  }, { threshold: 0.15 });
  reveals.forEach(el => io.observe(el));
