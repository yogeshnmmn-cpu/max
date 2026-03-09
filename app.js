const STORAGE_KEY = "mini-crm-contacts";
const statusOrder = ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"];

const form = document.getElementById("contact-form");
const searchInput = document.getElementById("search");
const list = document.getElementById("contact-list");
const template = document.getElementById("contact-row-template");

let contacts = loadContacts();

render();

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const contact = {
    id: crypto.randomUUID(),
    name: document.getElementById("name").value.trim(),
    email: document.getElementById("email").value.trim(),
    company: document.getElementById("company").value.trim(),
    status: document.getElementById("status").value,
    followUp: document.getElementById("followUp").value,
  };

  contacts.unshift(contact);
  saveContacts();
  form.reset();
  render();
});

searchInput.addEventListener("input", render);

function loadContacts() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveContacts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts));
}

function render() {
  list.innerHTML = "";
  const query = searchInput.value.trim().toLowerCase();

  const filtered = contacts.filter((contact) => {
    const text = `${contact.name} ${contact.email} ${contact.company}`.toLowerCase();
    return text.includes(query);
  });

  for (const contact of filtered) {
    const row = template.content.firstElementChild.cloneNode(true);

    row.querySelector(".name").textContent = contact.name;
    row.querySelector(".email").textContent = contact.email;
    row.querySelector(".company").textContent = contact.company;

    const statusCell = row.querySelector(".status");
    const pill = document.createElement("span");
    pill.className = "status-pill";
    pill.textContent = contact.status;
    statusCell.appendChild(pill);

    row.querySelector(".followUp").textContent = contact.followUp;

    row.querySelector(".delete").addEventListener("click", () => {
      contacts = contacts.filter((item) => item.id !== contact.id);
      saveContacts();
      render();
    });

    row.querySelector(".status-next").addEventListener("click", () => {
      const index = statusOrder.indexOf(contact.status);
      const nextIndex = index < statusOrder.length - 1 ? index + 1 : index;
      contact.status = statusOrder[nextIndex];
      saveContacts();
      render();
    });

    list.appendChild(row);
  }
}
