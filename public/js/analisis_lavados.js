(function () {
  const dataNode = document.getElementById("analysis-lavados-data");
  if (!dataNode || !window.Chart) return;

  const data = JSON.parse(dataNode.textContent || "{}");
  const money = (value) => `Gs. ${new Intl.NumberFormat("es-PY", { maximumFractionDigits: 0 }).format(Number(value || 0))}`;
  const palette = ["#0f766e", "#1f6feb", "#b45309", "#7c3aed", "#dc2626", "#0891b2", "#4d7c0f", "#be185d", "#475569", "#ca8a04"];

  Chart.defaults.font.family = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.color = "#506078";

  function canvas(name) {
    return document.querySelector(`[data-analysis-chart="${name}"]`);
  }

  function emptyData(items) {
    return !items || !items.length;
  }

  function barChart(name, items, label, options) {
    const node = canvas(name);
    if (!node || emptyData(items)) return;
    new Chart(node, {
      type: "bar",
      data: {
        labels: items.map((item) => item.label),
        datasets: [{
          label,
          data: items.map((item) => item.value),
          backgroundColor: options?.color || "#0f766e",
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: options?.horizontal ? "y" : "x",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => options?.money ? money(context.raw) : String(context.raw || 0)
            }
          }
        },
        scales: {
          x: { beginAtZero: true, grid: { display: !options?.horizontal } },
          y: { beginAtZero: true, grid: { display: false } }
        }
      }
    });
  }

  const daily = data.daily || [];
  const dailyNode = canvas("daily");
  if (dailyNode && daily.length) {
    new Chart(dailyNode, {
      type: "bar",
      data: {
        labels: daily.map((item) => item.label),
        datasets: [
          { type: "line", label: "Lavados", data: daily.map((item) => item.lavados), borderColor: "#0f766e", backgroundColor: "#0f766e", yAxisID: "count", tension: .25 },
          { label: "Total servicios", data: daily.map((item) => item.total), backgroundColor: "rgba(31, 111, 235, .72)", yAxisID: "money" },
          { label: "Comision", data: daily.map((item) => item.comision), backgroundColor: "rgba(180, 83, 9, .72)", yAxisID: "money" }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              label: (context) => context.dataset.yAxisID === "money"
                ? `${context.dataset.label}: ${money(context.raw)}`
                : `${context.dataset.label}: ${context.raw}`
            }
          }
        },
        scales: {
          count: { beginAtZero: true, position: "left", grid: { display: false } },
          money: { beginAtZero: true, position: "right", ticks: { callback: (value) => money(value) } }
        }
      }
    });
  }

  const payments = data.payments || [];
  const paymentsNode = canvas("payments");
  if (paymentsNode && payments.length) {
    new Chart(paymentsNode, {
      type: "doughnut",
      data: {
        labels: payments.map((item) => item.label),
        datasets: [{
          data: payments.map((item) => item.value),
          backgroundColor: payments.map((item, index) => item.color || palette[index % palette.length])
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              label: (context) => `${context.label}: ${money(context.raw)}`
            }
          }
        }
      }
    });
  }

  barChart("services", data.services || [], "Usos", { horizontal: true, color: "#1f6feb" });
  barChart("serviceGroups", data.serviceGroups || [], "Usos", { horizontal: true, color: "#0f766e" });
  barChart("clientGroups", data.clientGroups || [], "Total", { horizontal: true, color: "#7c3aed", money: true });
  barChart("personal", data.personal || [], "Lavados", { horizontal: true, color: "#b45309" });
})();
