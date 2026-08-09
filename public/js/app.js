(function () {
  const clientSelect = document.querySelector("[data-client-select]");
  const quickClient = document.querySelector("[data-quick-client]");
  const clientSearch = document.querySelector("[data-client-search]");
  const clientResults = document.querySelector("[data-client-results]");

  function fillIfBlank(input, value) {
    if (!input || input.value.trim() || !value) return;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function prefillClientFromGroup(select) {
    const option = select.options[select.selectedIndex];
    if (!option || !option.value) return;
    const scope = select.closest("form") || document;
    fillIfBlank(scope.querySelector("input[name='ruc'], input[name='nuevo_ruc']"), option.dataset.ruc || "");
    fillIfBlank(scope.querySelector("input[name='nombre'], input[name='nuevo_nombre']"), option.dataset.razonSocial || "");
    fillIfBlank(scope.querySelector("input[name='direccion'], input[name='nuevo_direccion']"), option.dataset.direccion || "");
    fillIfBlank(scope.querySelector("input[name='telefono'], input[name='nuevo_telefono']"), option.dataset.telefono || "");
    fillIfBlank(scope.querySelector("input[name='email'], input[name='nuevo_email']"), option.dataset.email || "");
  }

  document.querySelectorAll("select[name='grupo_cliente_id'], select[name='nuevo_grupo_cliente_id']").forEach((select) => {
    select.addEventListener("change", () => prefillClientFromGroup(select));
  });

  if (clientSelect && quickClient) {
    let clientOptions = [];
    const quickFields = {
      chapa: quickClient.querySelector("input[name='nueva_chapa']"),
      marcaModelo: quickClient.querySelector("input[name='nuevo_marca_modelo']"),
      ruc: quickClient.querySelector("input[name='nuevo_ruc']"),
      nombre: quickClient.querySelector("input[name='nuevo_nombre']"),
      telefono: quickClient.querySelector("input[name='nuevo_telefono']"),
      direccion: quickClient.querySelector("input[name='nuevo_direccion']"),
      email: quickClient.querySelector("input[name='nuevo_email']"),
      grupo: quickClient.querySelector("select[name='nuevo_grupo_cliente_id']")
    };

    function optionText(cliente) {
      return `${cliente.chapa} - ${cliente.marca_modelo}${cliente.nombre ? ` - ${cliente.nombre}` : ""}${cliente.grupo_nombre ? ` (${cliente.grupo_nombre})` : ""}`;
    }

    function optionSearch(cliente) {
      return [cliente.chapa, cliente.marca_modelo, cliente.nombre, cliente.ruc, cliente.telefono, cliente.email]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    }

    function rebuildClientOptions(clientes, selectedId) {
      const currentValue = selectedId || clientSelect.value;
      clientSelect.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Crear cliente rapido";
      clientSelect.appendChild(empty);
      clientes.forEach((cliente) => {
        const option = document.createElement("option");
        option.value = cliente.id;
        option.textContent = optionText(cliente);
        option.dataset.search = optionSearch(cliente);
        option.dataset.chapa = cliente.chapa || "";
        option.dataset.marcaModelo = cliente.marca_modelo || "";
        option.dataset.ruc = cliente.ruc || "";
        option.dataset.nombre = cliente.nombre || "";
        option.dataset.telefono = cliente.telefono || "";
        option.dataset.direccion = cliente.direccion || "";
        option.dataset.email = cliente.email || "";
        option.dataset.grupoClienteId = cliente.grupo_cliente_id || "";
        clientSelect.appendChild(option);
      });
      if (currentValue && Array.from(clientSelect.options).some((option) => option.value === String(currentValue))) {
        clientSelect.value = String(currentValue);
      }
      clientOptions = Array.from(clientSelect.options).map((option) => ({
        option,
        text: `${option.textContent || ""} ${option.dataset.search || ""}`.toLowerCase(),
        chapa: (option.dataset.chapa || "").trim().toUpperCase(),
        value: option.value
      }));
    }

    rebuildClientOptions(Array.from(clientSelect.options)
      .filter((option) => option.value)
      .map((option) => ({
        id: option.value,
        chapa: option.dataset.chapa || "",
        marca_modelo: option.dataset.marcaModelo || "",
        ruc: option.dataset.ruc || "",
        nombre: option.dataset.nombre || "",
        telefono: option.dataset.telefono || "",
        direccion: option.dataset.direccion || "",
        email: option.dataset.email || "",
        grupo_cliente_id: option.dataset.grupoClienteId || "",
        grupo_nombre: option.dataset.grupoNombre || ""
      })));

    function fillQuickClient(option) {
      if (!option) return;
      quickFields.chapa.value = option.dataset.chapa || "";
      quickFields.marcaModelo.value = option.dataset.marcaModelo || "";
      quickFields.ruc.value = option.dataset.ruc || "";
      quickFields.nombre.value = option.dataset.nombre || "";
      quickFields.telefono.value = option.dataset.telefono || "";
      quickFields.direccion.value = option.dataset.direccion || "";
      if (quickFields.email) quickFields.email.value = option.dataset.email || "";
      quickFields.grupo.value = option.dataset.grupoClienteId || "";
    }

    const syncClientMode = () => {
      const creating = !clientSelect.value;
      quickClient.classList.toggle("is-hidden", !creating);
      quickClient.querySelectorAll("input[name='nueva_chapa'], input[name='nuevo_marca_modelo']").forEach((input) => {
        input.required = creating;
      });
    };
    clientSelect.addEventListener("change", syncClientMode);

    function chooseClient(option) {
      if (!option) return;
      fillQuickClient(option);
      clientSelect.value = option.value;
      clientSelect.dispatchEvent(new Event("change"));
      if (clientSearch) clientSearch.value = option.textContent.trim();
      if (clientResults) clientResults.classList.add("is-hidden");
    }

    function renderClientResults(matches, term) {
      if (!clientResults) return;
      clientResults.innerHTML = "";
      if (!term) {
        clientResults.classList.add("is-hidden");
        return;
      }
      const visibleMatches = matches.slice(0, 8);
      if (!visibleMatches.length) {
        const empty = document.createElement("div");
        empty.className = "client-result-empty";
        empty.textContent = "Sin clientes encontrados";
        clientResults.appendChild(empty);
        clientResults.classList.remove("is-hidden");
        return;
      }
      visibleMatches.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "client-result";
        button.textContent = item.option.textContent.trim();
        button.addEventListener("click", () => chooseClient(item.option));
        clientResults.appendChild(button);
      });
      clientResults.classList.remove("is-hidden");
    }

    if (clientSearch) {
      let searchTimer = null;
      clientSearch.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          const term = clientSearch.value.trim();
          try {
            const response = await fetch(`/clientes/buscar?q=${encodeURIComponent(term)}`, {
              headers: { Accept: "application/json" }
            });
            if (!response.ok) throw new Error("No se pudo buscar clientes.");
            const data = await response.json();
            rebuildClientOptions(data.clientes || []);
            const matchedItems = clientOptions.filter((item) => item.value);
            renderClientResults(matchedItems, term.toLowerCase());
            if (term && matchedItems.length === 1) {
              clientSelect.value = matchedItems[0].value;
              clientSelect.dispatchEvent(new Event("change"));
            }
            if (!term && !clientSelect.value) {
              clientSelect.value = "";
              clientSelect.dispatchEvent(new Event("change"));
            }
          } catch (error) {
            renderClientResults([], term.toLowerCase());
          }
        }, 250);
      });
    }
  if (quickFields.chapa) {
      quickFields.chapa.addEventListener("change", () => {
        const chapa = quickFields.chapa.value.trim().toUpperCase();
        if (!chapa) return;
        const match = clientOptions.find((item) => item.value && item.chapa === chapa);
        if (!match) return;
        chooseClient(match.option);
      });
    }
    syncClientMode();
  }

  function normalizeSearchText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  document.querySelectorAll("[data-crud-search-scope]").forEach((scope) => {
    const input = scope.querySelector("[data-crud-search]");
    const rows = Array.from(scope.querySelectorAll("[data-crud-row]"));
    const count = scope.querySelector("[data-crud-search-count]");
    const noResults = scope.querySelector("[data-crud-no-results]");
    const empty = scope.querySelector("[data-crud-empty]");
    if (!input || !rows.length) return;

    const searchableRows = rows.map((row) => ({
      row,
      text: normalizeSearchText(`${row.dataset.search || ""} ${row.textContent || ""}`)
    }));

    function updateCrudSearch() {
      const term = normalizeSearchText(input.value);
      let visible = 0;
      searchableRows.forEach((item) => {
        const match = !term || item.text.includes(term);
        item.row.classList.toggle("is-hidden", !match);
        if (match) visible += 1;
      });
      if (count) {
        const label = visible === 1 ? "registro" : "registros";
        count.textContent = `${visible} ${label}`;
      }
      if (noResults) noResults.classList.toggle("is-hidden", visible !== 0);
      if (empty) empty.classList.add("is-hidden");
    }

    input.addEventListener("input", updateCrudSearch);
    updateCrudSearch();
  });

  const relatedGroupRows = Array.from(document.querySelectorAll("[data-related-group-row]"));
  const relatedPanels = Array.from(document.querySelectorAll("[data-related-panel]"));
  const relatedEmpty = document.querySelector("[data-related-empty]");
  const tabButtons = Array.from(document.querySelectorAll("[data-tab-button]"));
  function showTab(tabId) {
    const panelScope = document.querySelector(`[data-tab-panel="${tabId}"]`)?.closest("[data-related-panel]");
    if (!panelScope) return;
    panelScope.querySelectorAll("[data-tab-button]").forEach((button) => {
      button.classList.toggle("is-selected", button.dataset.tabButton === tabId);
    });
    panelScope.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      panel.classList.toggle("is-hidden", panel.dataset.tabPanel !== tabId);
    });
  }

  if (relatedGroupRows.length && relatedPanels.length) {
    function showRelatedItems(groupId) {
      relatedGroupRows.forEach((row) => {
        row.classList.toggle("is-selected", row.dataset.relatedGroupRow === groupId);
      });
      relatedPanels.forEach((panel) => {
        panel.classList.toggle("is-hidden", panel.dataset.relatedPanel !== groupId);
      });
      if (relatedEmpty) relatedEmpty.classList.add("is-hidden");
    }

    relatedGroupRows.forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("a, button, form, input, label")) return;
        showRelatedItems(row.dataset.relatedGroupRow);
      });
    });

    const params = new URLSearchParams(window.location.search);
    const selectedRelated = params.get("related");
    if (selectedRelated) {
      showRelatedItems(selectedRelated);
      const selectedTab = params.get("tab");
      if (selectedTab) showTab(`${selectedTab}-${selectedRelated}`);
    }
  }

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tabButton));
  });

  document.querySelectorAll("[data-uppercase]").forEach((input) => {
    input.value = input.value.toUpperCase();
    input.addEventListener("input", () => {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = input.value.toUpperCase();
      input.setSelectionRange(start, end);
    });
  });

  function parseIntegerMoney(value) {
    const raw = String(value || "0").trim().replace(/[^\d.,-]/g, "");
    let normalized = raw;
    const lastDot = raw.lastIndexOf(".");
    const lastComma = raw.lastIndexOf(",");

    if (lastDot >= 0 && lastComma >= 0) {
      const decimalSeparator = lastDot > lastComma ? "." : ",";
      const thousandsSeparator = decimalSeparator === "." ? "," : ".";
      normalized = raw.split(thousandsSeparator).join("").replace(decimalSeparator, ".");
    } else if (lastDot >= 0) {
      const decimals = raw.length - lastDot - 1;
      normalized = decimals === 3 ? raw.replace(/\./g, "") : raw;
    } else if (lastComma >= 0) {
      const decimals = raw.length - lastComma - 1;
      normalized = decimals === 3 ? raw.replace(/,/g, "") : raw.replace(",", ".");
    }

    const number = Number(normalized || 0);
    return Number.isFinite(number) ? Math.round(number) : 0;
  }

  function formatGuarani(value) {
    return new Intl.NumberFormat("es-PY", {
      style: "currency",
      currency: "PYG",
      maximumFractionDigits: 0
    }).format(parseIntegerMoney(value));
  }

  document.querySelectorAll("[data-money-input]").forEach((input) => {
    if (input.value) input.value = formatGuarani(input.value);
    input.addEventListener("focus", () => {
      const value = parseIntegerMoney(input.value);
      input.value = value ? String(value) : "";
      input.select();
    });
    input.addEventListener("blur", () => {
      if (!input.value.trim()) return;
      input.value = formatGuarani(input.value);
    });
  });

  const valeSaldoBox = document.querySelector("[data-vale-saldo-box]");
  if (valeSaldoBox) {
    const valeForm = valeSaldoBox.closest("form");
    const personalInput = valeForm?.querySelector("select[name='personal_id']");
    const fechaInput = valeForm?.querySelector("input[name='fecha_pago']");
    const saldoNode = valeSaldoBox.querySelector("[data-vale-saldo]");
    const comisionNode = valeSaldoBox.querySelector("[data-vale-comision]");
    const valesNode = valeSaldoBox.querySelector("[data-vale-vales]");

    async function updateValeSaldo() {
      const personalId = personalInput?.value || "";
      const fecha = fechaInput?.value || "";
      if (!personalId || !fecha) {
        if (saldoNode) saldoNode.textContent = "Seleccione personal";
        if (comisionNode) comisionNode.textContent = formatGuarani(0);
        if (valesNode) valesNode.textContent = formatGuarani(0);
        return;
      }
      if (saldoNode) saldoNode.textContent = "Calculando...";
      try {
        const response = await fetch(`/vales/saldo?personal_id=${encodeURIComponent(personalId)}&fecha=${encodeURIComponent(fecha)}`, {
          headers: { Accept: "application/json" }
        });
        if (!response.ok) throw new Error("No se pudo obtener el saldo.");
        const data = await response.json();
        if (saldoNode) saldoNode.textContent = formatGuarani(data.saldo_personal || 0);
        if (comisionNode) comisionNode.textContent = formatGuarani(data.total_comision_40 || 0);
        if (valesNode) valesNode.textContent = formatGuarani(data.total_vales || 0);
      } catch (error) {
        if (saldoNode) saldoNode.textContent = "No disponible";
      }
    }

    personalInput?.addEventListener("change", updateValeSaldo);
    fechaInput?.addEventListener("change", updateValeSaldo);
    document.querySelector("[data-open-crud-modal]")?.addEventListener("click", () => {
      window.setTimeout(updateValeSaldo, 0);
    });
    updateValeSaldo();
  }

  const invoiceForm = document.querySelector("[data-invoice-form]");
  if (invoiceForm) {
    const clientIdInput = invoiceForm.querySelector("[data-invoice-client-id]");
    const clientSearchInput = invoiceForm.querySelector("[data-invoice-client-search]");
    const clientResultsBox = invoiceForm.querySelector("[data-invoice-client-results]");
    const rucInput = invoiceForm.querySelector("input[name='cliente_ruc']");
    const nombreInput = invoiceForm.querySelector("input[name='cliente_nombre']");
    const rucStatus = invoiceForm.querySelector("[data-invoice-ruc-status]");
    const itemsBox = invoiceForm.querySelector("[data-invoice-items]");
    const itemTemplate = invoiceForm.querySelector("[data-invoice-item-template]");
    const addItemButton = invoiceForm.querySelector("[data-add-invoice-item]");
    const subtotalNode = invoiceForm.querySelector("[data-invoice-subtotal]");
    const ivaNode = invoiceForm.querySelector("[data-invoice-iva]");
    const totalNodeInvoice = invoiceForm.querySelector("[data-invoice-total]");

    function invoiceQuantity(value) {
      const number = Number(String(value || "0").replace(",", "."));
      return Number.isFinite(number) ? number : 0;
    }

    function wireInvoiceMoney(input) {
      if (!input || input.dataset.invoiceMoneyReady) return;
      input.dataset.invoiceMoneyReady = "1";
      if (input.value) input.value = formatGuarani(input.value);
      input.addEventListener("focus", () => {
        const value = parseIntegerMoney(input.value);
        input.value = value ? String(value) : "";
        input.select();
      });
      input.addEventListener("blur", () => {
        if (input.value.trim()) input.value = formatGuarani(input.value);
      });
    }

    function recalcInvoice() {
      let total = 0;
      itemsBox.querySelectorAll("[data-invoice-item-line]").forEach((line) => {
        const quantity = invoiceQuantity(line.querySelector("[data-invoice-quantity]")?.value);
        const price = parseIntegerMoney(line.querySelector("[data-invoice-price]")?.value);
        const lineTotal = Math.round(quantity * price);
        total += lineTotal;
        const totalInput = line.querySelector("[data-invoice-line-total]");
        if (totalInput) totalInput.value = formatGuarani(lineTotal);
      });
      if (subtotalNode) subtotalNode.textContent = formatGuarani(total);
      if (ivaNode) ivaNode.textContent = formatGuarani(Math.round(total / 11));
      if (totalNodeInvoice) totalNodeInvoice.textContent = formatGuarani(total);
    }

    function wireInvoiceLine(line) {
      const service = line.querySelector("[data-invoice-service]");
      const description = line.querySelector("input[name='descripcion']");
      const quantity = line.querySelector("[data-invoice-quantity]");
      const price = line.querySelector("[data-invoice-price]");
      const remove = line.querySelector("[data-remove-invoice-item]");
      wireInvoiceMoney(price);
      if (description && !description.dataset.upperReady) {
        description.dataset.upperReady = "1";
        description.addEventListener("input", () => {
          const start = description.selectionStart;
          const end = description.selectionEnd;
          description.value = description.value.toUpperCase();
          description.setSelectionRange(start, end);
        });
      }
      if (service) {
        service.addEventListener("change", () => {
          const option = service.options[service.selectedIndex];
          if (!option || !option.value) return;
          if (description) description.value = option.dataset.name || "";
          if (price) price.value = formatGuarani(option.dataset.price || "0");
          recalcInvoice();
        });
      }
      [quantity, price].forEach((input) => {
        if (!input) return;
        input.addEventListener("input", recalcInvoice);
        input.addEventListener("blur", recalcInvoice);
      });
      if (remove) {
        remove.addEventListener("click", () => {
          if (itemsBox.querySelectorAll("[data-invoice-item-line]").length <= 1) return;
          line.remove();
          recalcInvoice();
        });
      }
    }

    itemsBox.querySelectorAll("[data-invoice-item-line]").forEach(wireInvoiceLine);
    recalcInvoice();

    if (addItemButton && itemTemplate) {
      addItemButton.addEventListener("click", () => {
        const count = itemsBox.querySelectorAll("[data-invoice-item-line]").length;
        if (count >= 9) return;
        const fragment = itemTemplate.content.cloneNode(true);
        const line = fragment.querySelector("[data-invoice-item-line]");
        itemsBox.appendChild(fragment);
        wireInvoiceLine(line);
        recalcInvoice();
      });
    }

    function chooseInvoiceClient(cliente) {
      if (clientIdInput) clientIdInput.value = cliente.id || "";
      const direccion = invoiceForm.querySelector("input[name='cliente_direccion']");
      if (nombreInput) nombreInput.value = cliente.nombre || "";
      if (rucInput) rucInput.value = cliente.ruc || "";
      if (direccion) direccion.value = cliente.direccion || "";
      if (clientSearchInput) clientSearchInput.value = [cliente.chapa, cliente.marca_modelo, cliente.nombre].filter(Boolean).join(" - ");
      if (clientResultsBox) clientResultsBox.classList.add("is-hidden");
      setRucStatus("");
    }

    function setRucStatus(message, state) {
      if (!rucStatus) return;
      rucStatus.textContent = message || "";
      rucStatus.dataset.state = state || "";
    }

    async function lookupInvoiceRuc() {
      if (!rucInput) return;
      const ruc = rucInput.value.trim();
      if (!ruc) {
        setRucStatus("");
        return;
      }

      setRucStatus("Consultando RUC...", "pending");
      try {
        const response = await fetch(`/facturas/ruc?ruc=${encodeURIComponent(ruc)}`, {
          headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setRucStatus(data.message || "No se pudo consultar el RUC.", "error");
          return;
        }
        if (!data.found) {
          setRucStatus(data.message || "RUC no existe.", "error");
          return;
        }
        if (nombreInput) {
          nombreInput.value = data.nombre || "";
          nombreInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (rucInput && data.ruc) {
          rucInput.value = data.ruc;
          rucInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        setRucStatus(`Encontrado${data.estado ? `: ${data.estado}` : ""}`, "success");
      } catch (error) {
        setRucStatus("No se pudo consultar el RUC.", "error");
      }
    }

    rucInput?.addEventListener("blur", lookupInvoiceRuc);

    if (clientSearchInput && clientResultsBox) {
      let timer = null;
      clientSearchInput.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const term = clientSearchInput.value.trim();
          clientResultsBox.innerHTML = "";
          if (!term) {
            clientResultsBox.classList.add("is-hidden");
            return;
          }
          try {
            const response = await fetch(`/clientes/buscar?q=${encodeURIComponent(term)}`, {
              headers: { Accept: "application/json" }
            });
            if (!response.ok) throw new Error("No se pudo buscar clientes.");
            const data = await response.json();
            const clientes = (data.clientes || []).slice(0, 8);
            if (!clientes.length) {
              const empty = document.createElement("div");
              empty.className = "client-result-empty";
              empty.textContent = "Sin clientes encontrados";
              clientResultsBox.appendChild(empty);
            }
            clientes.forEach((cliente) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "client-result";
              button.textContent = [cliente.chapa, cliente.marca_modelo, cliente.nombre, cliente.ruc].filter(Boolean).join(" - ");
              button.addEventListener("click", () => chooseInvoiceClient(cliente));
              clientResultsBox.appendChild(button);
            });
            clientResultsBox.classList.remove("is-hidden");
          } catch (error) {
            clientResultsBox.classList.remove("is-hidden");
          }
        }, 250);
      });
    }
  }

  document.querySelectorAll("[data-image-input]").forEach((input) => {
    const preview = document.querySelector(`[data-image-preview="${input.dataset.imageInput}"]`);
    const pathInput = document.querySelector(`[data-image-path="${input.dataset.imageInput}"]`);
    if (!preview) return;
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      preview.src = URL.createObjectURL(file);
      preview.classList.remove("is-hidden");
      if (pathInput) {
        const folder = input.dataset.imageFolder || "servicio-grupos";
        const safeName = file.name
          .replace(/\.[^/.]+$/, "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "imagen";
        pathInput.value = `/uploads/${folder}/${safeName}.png`;
      }
    });
  });

  const personalInput = document.querySelector("[data-personal-input]");
  const personalButtons = document.querySelector("[data-personal-buttons]");
  if (personalInput && personalButtons) {
    personalButtons.querySelectorAll("[data-personal-id]").forEach((button) => {
      button.addEventListener("click", () => {
        personalInput.value = button.dataset.personalId;
        personalButtons.querySelectorAll("[data-personal-id]").forEach((item) => item.classList.remove("is-selected"));
        button.classList.add("is-selected");
      });
    });
  }

  const list = document.querySelector("[data-services-list]");
  const template = document.querySelector("[data-service-template]");
  const addButton = document.querySelector("[data-add-service]");
  const serviceGroupButtons = document.querySelector("[data-service-group-buttons]");
  const totalNode = document.querySelector("[data-total]");
  const comisionNode = document.querySelector("[data-comision]");
  const saldoNode = document.querySelector("[data-saldo]");
  let selectedServiceGroupId = serviceGroupButtons
    ? (serviceGroupButtons.querySelector(".is-selected")?.dataset.serviceGroupId || "")
    : "";

  function parseMoney(value) {
    return parseIntegerMoney(value);
  }

  function format(value) {
    return new Intl.NumberFormat("es-PY", { maximumFractionDigits: 0 }).format(value);
  }

  function recalc() {
    if (!list) return;
    let total = 0;
    list.querySelectorAll("[data-price-input]").forEach((input) => {
      total += parseMoney(input.value);
    });
    if (totalNode) totalNode.textContent = format(total);
    if (comisionNode) comisionNode.textContent = format(total * 0.4);
    if (saldoNode) saldoNode.textContent = format(total * 0.6);
  }

  function applyServiceGroupFilter(select) {
    if (!select) return;
    let selectedOptionVisible = true;
    Array.from(select.options).forEach((option) => {
      const optionGroupId = option.dataset.serviceGroupId || "";
      const visible = !option.value || !selectedServiceGroupId || optionGroupId === selectedServiceGroupId;
      option.hidden = !visible;
      if (option.selected && !visible) selectedOptionVisible = false;
    });
    if (!selectedOptionVisible) {
      select.value = "";
      const input = select.closest(".service-line")?.querySelector("[data-price-input]");
      if (input) input.value = "";
    }
  }

  function applyServiceGroupToAllLines() {
    if (!list) return;
    list.querySelectorAll("[data-service-price]").forEach(applyServiceGroupFilter);
    recalc();
  }

  function wireLine(line) {
    const select = line.querySelector("[data-service-price]");
    const input = line.querySelector("[data-price-input]");
    const remove = line.querySelector("[data-remove-service]");
    if (select && input) {
      applyServiceGroupFilter(select);
      select.addEventListener("change", () => {
        const option = select.options[select.selectedIndex];
        input.value = option && option.dataset.price ? option.dataset.price : "";
        recalc();
      });
      input.addEventListener("input", recalc);
    }
    if (remove) {
      remove.addEventListener("click", () => {
        if (list.querySelectorAll(".service-line").length > 1) line.remove();
        recalc();
      });
    }
  }

  if (list) {
    list.querySelectorAll(".service-line").forEach(wireLine);
    if (serviceGroupButtons) {
      serviceGroupButtons.querySelectorAll("[data-service-group-id]").forEach((button) => {
        button.addEventListener("click", () => {
          selectedServiceGroupId = button.dataset.serviceGroupId || "";
          serviceGroupButtons.querySelectorAll("[data-service-group-id]").forEach((item) => item.classList.remove("is-selected"));
          button.classList.add("is-selected");
          applyServiceGroupToAllLines();
        });
      });
      applyServiceGroupToAllLines();
    }
    addButton.addEventListener("click", () => {
      const fragment = template.content.cloneNode(true);
      const line = fragment.querySelector(".service-line");
      list.appendChild(fragment);
      wireLine(line);
    });
    recalc();
  }

  const paymentModal = document.querySelector("[data-payment-modal]");
  if (paymentModal) {
    let pendingPaymentForm = null;
    const fields = {
      lavado: paymentModal.querySelector("[data-modal-lavado]"),
      auto: paymentModal.querySelector("[data-modal-auto]"),
      personal: paymentModal.querySelector("[data-modal-personal]"),
      total: paymentModal.querySelector("[data-modal-total]"),
      pagoActual: paymentModal.querySelector("[data-modal-pago-actual]"),
      pagoNuevo: paymentModal.querySelector("[data-modal-pago-nuevo]")
    };
    const yesButton = paymentModal.querySelector("[data-payment-confirm-yes]");
    const noButton = paymentModal.querySelector("[data-payment-confirm-no]");

    function closePaymentModal() {
      paymentModal.classList.add("is-hidden");
      pendingPaymentForm = null;
    }

    document.querySelectorAll("[data-payment-confirm]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        pendingPaymentForm = button.closest("form");
        fields.lavado.textContent = button.dataset.lavadoId || "";
        fields.auto.textContent = button.dataset.auto || "";
        fields.personal.textContent = button.dataset.personal || "";
        fields.total.textContent = button.dataset.total || "";
        fields.pagoActual.textContent = button.dataset.pagoActual || "";
        fields.pagoNuevo.textContent = button.dataset.pagoNuevo || "";
        paymentModal.classList.remove("is-hidden");
        yesButton.focus();
      });
    });

    yesButton.addEventListener("click", () => {
      if (pendingPaymentForm) pendingPaymentForm.submit();
    });

    noButton.addEventListener("click", closePaymentModal);
    paymentModal.addEventListener("click", (event) => {
      if (event.target === paymentModal) closePaymentModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !paymentModal.classList.contains("is-hidden")) closePaymentModal();
    });
  }

  const crudModal = document.querySelector("[data-crud-modal]");
  const openCrudModal = document.querySelector("[data-open-crud-modal]");
  if (crudModal) {
    const crudForm = crudModal.querySelector("[data-crud-modal-form]");
    const crudTitle = crudModal.querySelector("[data-crud-modal-title]");

    function closeCrudModal() {
      crudModal.classList.add("is-hidden");
      if (window.location.search.includes("edit=")) {
        window.location.href = window.location.pathname;
      }
    }

    function openNewCrudModal() {
      if (!crudForm) return;
      crudForm.action = crudForm.dataset.createAction || window.location.pathname;
      if (crudTitle) crudTitle.textContent = crudForm.dataset.newTitle || "Nuevo registro";
      crudForm.querySelectorAll("input, select").forEach((field) => {
        if (field.type === "checkbox") {
          field.checked = true;
        } else if (field.type === "file") {
          field.value = "";
        } else {
          field.value = field.dataset.defaultValue || "";
        }
      });
      crudForm.querySelectorAll("[data-image-preview]").forEach((preview) => {
        preview.removeAttribute("src");
        preview.classList.add("is-hidden");
      });
      crudModal.classList.remove("is-hidden");
      const firstInput = crudForm.querySelector("input:not([type='checkbox']), select");
      if (firstInput) firstInput.focus();
    }

    if (openCrudModal) {
      openCrudModal.addEventListener("click", openNewCrudModal);
    }
    crudModal.querySelectorAll("[data-close-crud-modal]").forEach((button) => {
      button.addEventListener("click", closeCrudModal);
    });
    crudModal.addEventListener("click", (event) => {
      if (event.target === crudModal) closeCrudModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !crudModal.classList.contains("is-hidden")) closeCrudModal();
    });
  }

  document.querySelectorAll("form[data-confirm]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });
})();
