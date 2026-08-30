(function () {
  const logo = new URL("logo.png", window.location.href).href;
  const TOKEN = {
    address: "0x5D1B6B802401866EE9B613B5f495F9eFb1017649",
    symbol: "DiRo",
    decimals: 18,
    image: logo
  };

  const button = document.getElementById("add");
  const status = document.getElementById("status");
  if (!button || !status) return;

  button.addEventListener("click", async function () {
    if (!window.ethereum) {
      status.textContent = "Откройте MetaMask или Rabby в этом браузере.";
      return;
    }
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x89" }]
      });
    } catch (err) {
      if (err && err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x89",
            chainName: "Polygon Mainnet",
            nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
            rpcUrls: ["https://polygon-rpc.com"],
            blockExplorerUrls: ["https://polygonscan.com/"]
          }]
        });
      }
    }
    const ok = await window.ethereum.request({
      method: "wallet_watchAsset",
      params: { type: "ERC20", options: TOKEN }
    });
    status.textContent = ok
      ? "Токен добавлен. Проверьте список активов."
      : "Добавление отменено.";
  });
})();
