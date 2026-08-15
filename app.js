/* ============================================
   NEPAL CIVIL ENGINEERING PWA - APP LOGIC
   ============================================ */

// ============================================
// DATABASE LAYER (Dexie.js)
// ============================================
const db = new Dexie('NepalCivilPWA');

db.version(1).stores({
  projects: 'id, name, createdAt, updatedAt',
  estimateItems: 'id, projectId, itemNo, createdAt',
  estimateSubRows: 'id, projectId, estimateItemId, createdAt',
  measurementItems: 'id, projectId, estimateItemId, itemNo, createdAt',
  measurementSubRows: 'id, projectId, measurementItemId, createdAt',
  photos: 'id, projectId, itemId, subRowId, type, createdAt',
  letterheads: 'id, projectId, reportType'
});

// ============================================
// MATH PARSER (Safe Expression Evaluator)
// ============================================
const MathParser = {
  evaluate(expr) {
    if (!expr || typeof expr !== 'string') return 0;
    const trimmed = expr.trim();
    if (trimmed === '') return 0;

    if (!/^[\d\+\-*/().\s]+$/.test(trimmed)) return NaN;
    if (/[\+\-*/]{2,}/.test(trimmed)) return NaN;
    if (/^[*/]|\(\)|\(\*|\+/.test(trimmed)) return NaN;

    try {
      const result = new Function('return (' + trimmed + ')')();
      if (typeof result === 'number' && isFinite(result)) return result;
      return NaN;
    } catch (e) { return NaN; }
  },

  formatNumber(num, decimals = 3) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    return num.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  },

  formatCurrency(num) {
    if (num === null || num === undefined || isNaN(num)) return 'Rs. -';
    return 'Rs. ' + num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
};

// ============================================
// STATE MANAGEMENT
// ============================================
const AppState = {
  view: 'dashboard',
  projectId: null,
  tab: 'setup',
  projects: [],
  currentProject: null,
  estimates: [],
  measurements: [],
  photos: [],
  letterhead: null,
  expandedItems: new Set(),
  toastId: 0,

  async loadProjects() {
    this.projects = await db.projects.orderBy('updatedAt').reverse().toArray();
  },

  async loadProjectData(pid) {
    this.currentProject = await db.projects.get(pid);
    this.estimates = await db.estimateItems.where('projectId').equals(pid).sortBy('itemNo');
    this.measurements = await db.measurementItems.where('projectId').equals(pid).sortBy('itemNo');
    this.photos = await db.photos.where('projectId').equals(pid).toArray();
    this.letterhead = await db.letterheads.where('projectId').equals(pid).first();
  }
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
const Utils = {
  generateId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  },

  debounce(fn, ms = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  },

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  },

  deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
};

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const id = ++AppState.toastId;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i class="fas ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle'}"></i>
    <span>${Utils.escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================
// PHOTO ENGINE (Compression & Geotagging)
// ============================================
const PhotoEngine = {
  async compressImage(file, maxWidth = 1200, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxWidth / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  },

  async getGeolocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { timeout: 5000, enableHighAccuracy: false }
      );
    });
  },

  async savePhoto(file, projectId, itemId, subRowId, type, caption = '') {
    try {
      const compressed = await this.compressImage(file);
      const geotag = await this.getGeolocation();

      const photo = {
        id: Utils.generateId(),
        projectId,
        itemId,
        subRowId,
        type,
        data: compressed,
        geotag,
        caption,
        timestamp: Date.now(),
        createdAt: Date.now()
      };

      await db.photos.add(photo);
      AppState.photos.push(photo);
      return photo;
    } catch (err) {
      console.error('Photo save error:', err);
      showToast('Failed to save photo: ' + err.message, 'error');
      return null;
    }
  },

  async deletePhoto(photoId) {
    await db.photos.delete(photoId);
    AppState.photos = AppState.photos.filter(p => p.id !== photoId);
  },

  getPhotosForSubRow(subRowId) {
    return AppState.photos.filter(p => p.subRowId === subRowId);
  }
};

// ============================================
// PROGRESS DATA COMPUTER
// ============================================
const ProgressEngine = {
  compute(projectId) {
    const estimates = AppState.estimates;
    const measurements = AppState.measurements;
    const project = AppState.currentProject;

    let totalEstQty = 0, totalEstAmt = 0;
    let totalMeasQty = 0, totalMeasAmt = 0;

    const rows = estimates.map(est => {
      const meas = measurements.find(m => m.estimateItemId === est.id);
      const estQty = est.totalQuantity || 0;
      const estAmt = est.totalAmount || 0;
      const measQty = meas?.totalQuantity || 0;
      const measAmt = meas?.totalAmount || 0;
      const varQty = measQty - estQty;
      const varAmt = measAmt - estAmt;
      const progress = estQty > 0 ? (measQty / estQty * 100) : 0;
      const rate = est.sanctionedRate || 0;

      totalEstQty += estQty;
      totalEstAmt += estAmt;
      totalMeasQty += measQty;
      totalMeasAmt += measAmt;

      let status = 'Not Started';
      let barColor = 'red';
      let statusColor = '#991b1b';
      let statusBg = '#fee2e2';

      if (progress >= 100) {
        status = 'Target Achieved (100%)';
        barColor = 'green';
        statusColor = '#166534';
        statusBg = '#dcfce7';
      } else if (progress > 0) {
        status = `In Progress (${progress.toFixed(1)}%)`;
        barColor = 'blue';
        statusColor = '#1e40af';
        statusBg = '#dbeafe';
      }
      if (varQty > 0 && progress > 100) {
        status = `Exceeded Estimate (${progress.toFixed(1)}%)`;
        barColor = 'red';
        statusColor = '#991b1b';
        statusBg = '#fee2e2';
      }

      return {
        est, meas, estQty, estAmt, measQty, measAmt,
        varQty, varAmt, progress, status, barColor,
        statusColor, statusBg, rate,
        itemNo: est.itemNo,
        description: est.description,
        unit: est.unit
      };
    });

    const overallProgress = totalEstQty > 0 ? (totalMeasQty / totalEstQty * 100) : 0;
    const financialProgress = totalEstAmt > 0 ? (totalMeasAmt / totalEstAmt * 100) : 0;

    return {
      rows,
      totalEstQty, totalEstAmt,
      totalMeasQty, totalMeasAmt,
      overallProgress, financialProgress,
      project
    };
  }
};


// ============================================
// EXPORT ENGINE (PDF & Excel)
// ============================================
const ExportEngine = {
  async getLetterhead(projectId, reportType = 'default') {
    const custom = await db.letterheads.where({ projectId, reportType }).first();
    if (custom) return custom;
    const project = await db.projects.get(projectId);
    return project?.letterhead || null;
  },

  getReportTitle(type) {
    const titles = {
      estimate: 'COST ESTIMATE',
      measurement: 'MEASUREMENT BOOK',
      progress: 'WORK PROGRESS REPORT'
    };
    return titles[type] || 'REPORT';
  },

  getReportSubtitle(type) {
    const subtitles = {
      estimate: 'Detailed Cost Breakdown with Sub-Row Entries',
      measurement: 'As-Built Field Measurement Records',
      progress: 'Estimate vs Measurement Comparison Analysis'
    };
    return subtitles[type] || '';
  },

  // ============================================
  // PDF GENERATOR
  // ============================================
  async generatePDF(project, items, type, measurements = []) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const letterhead = await this.getLetterhead(project.id, type);
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 15;
    let y = 12;

    // === LETTERHEAD ===
    if (letterhead?.logo) {
      try { doc.addImage(letterhead.logo, 'JPEG', margin, y, 22, 22); } catch(e) {}
    }

    doc.setFontSize(9);
    doc.setTextColor(100);
    if (letterhead?.departmentName) {
      doc.setFontSize(13);
      doc.setTextColor(30);
      doc.setFont('helvetica', 'bold');
      doc.text(letterhead.departmentName, margin + 26, y + 7);
    }
    if (letterhead?.officeAddress) {
      doc.setFontSize(8);
      doc.setTextColor(80);
      doc.setFont('helvetica', 'normal');
      doc.text(letterhead.officeAddress, margin + 26, y + 12);
    }
    if (letterhead?.contactInfo) {
      doc.setFontSize(7);
      doc.text(letterhead.contactInfo, margin + 26, y + 16);
    }

    y += 24;

    // === PROMINENT CENTERED REPORT TITLE ===
    doc.setFillColor(15, 23, 42);
    doc.rect(margin, y, pageWidth - margin * 2, 14, 'F');
    doc.setFontSize(14);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.text(this.getReportTitle(type), pageWidth / 2, y + 9, { align: 'center' });

    y += 18;

    // Report subtitle
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.setFont('helvetica', 'italic');
    doc.text(this.getReportSubtitle(type), pageWidth / 2, y, { align: 'center' });
    doc.setFont('helvetica', 'normal');

    y += 6;

    // === PROJECT META ===
    doc.setDrawColor(200);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageWidth - margin, y);
    y += 5;

    doc.setFontSize(8.5);
    doc.setTextColor(50);

    const metaFields = [
      ['Project Name:', project.name],
      ['Location:', project.location],
      ['Budget Head:', project.budgetHead],
      ['Allocation:', 'Rs. ' + MathParser.formatNumber(project.totalAllocation || 0, 2)],
      ['Commencement:', Utils.formatDate(project.dateOfCommencement)],
      ['Contractor:', project.contractorDetails]
    ];

    metaFields.forEach(([label, value]) => {
      doc.setFont('helvetica', 'bold');
      doc.text(label, margin, y);
      doc.setFont('helvetica', 'normal');
      doc.text(String(value || '-'), margin + 32, y);
      y += 4.5;
    });

    y += 3;
    doc.line(margin, y - 2, pageWidth - margin, y - 2);
    y += 4;

    // === TABLE DATA BASED ON TYPE ===
    if (type === 'progress') {
      await this.renderProgressPDF(doc, project, items, measurements, margin, pageWidth, y);
    } else {
      await this.renderStandardPDF(doc, items, type, margin, pageWidth, y);
    }

    // === PHOTO APPENDIX ===
    const itemPhotos = AppState.photos.filter(p => p.type === type);
    if (itemPhotos.length > 0) {
      doc.addPage();
      doc.setFillColor(15, 23, 42);
      doc.rect(margin, 12, pageWidth - margin * 2, 10, 'F');
      doc.setFontSize(12);
      doc.setTextColor(255);
      doc.setFont('helvetica', 'bold');
      doc.text('PHOTO DOCUMENTATION', pageWidth / 2, 18.5, { align: 'center' });

      doc.setFontSize(8);
      doc.setTextColor(100);
      doc.setFont('helvetica', 'normal');
      doc.text(`Total Photos: ${itemPhotos.length}`, margin, 28);

      let photoY = 32;
      let photoX = margin;
      const photoW = 80;
      const photoH = 55;
      const gap = 8;

      for (let i = 0; i < itemPhotos.length; i++) {
        const photo = itemPhotos[i];

        if (photoY + photoH > doc.internal.pageSize.getHeight() - 20) {
          doc.addPage();
          photoY = 15;
          photoX = margin;
        }

        if (photoX + photoW > pageWidth - margin) {
          photoX = margin;
          photoY += photoH + 18;
        }

        try {
          doc.addImage(photo.data, 'JPEG', photoX, photoY, photoW, photoH);
        } catch(e) {
          doc.setFillColor(240, 240, 240);
          doc.rect(photoX, photoY, photoW, photoH, 'F');
          doc.setFontSize(7);
          doc.setTextColor(150);
          doc.text('Image unavailable', photoX + 5, photoY + photoH / 2);
        }

        doc.setFontSize(6.5);
        doc.setTextColor(80);
        const caption = `${photo.caption || 'Photo'} ${photo.geotag ? `(${photo.geotag.lat.toFixed(4)}, ${photo.geotag.lng.toFixed(4)})` : ''}`;
        doc.text(caption, photoX, photoY + photoH + 4);

        photoX += photoW + gap;
      }
    }

    doc.save(`${project.name}_${type}_${new Date().toISOString().split('T')[0]}.pdf`);
    showToast('PDF exported successfully', 'success');
  },

  // Standard Estimate / Measurement PDF
  async renderStandardPDF(doc, items, type, margin, pageWidth, startY) {
    const tableData = [];
    let grandTotalQty = 0;
    let grandTotalAmt = 0;

    items.forEach(item => {
      tableData.push([
        { content: item.itemNo, styles: { fontStyle: 'bold', fillColor: [240, 249, 255] } },
        { content: item.description, styles: { fontStyle: 'bold', fillColor: [240, 249, 255] } },
        { content: item.unit, styles: { fontStyle: 'bold', fillColor: [240, 249, 255] } },
        { content: MathParser.formatNumber(item.sanctionedRate, 2), styles: { fontStyle: 'bold', fillColor: [240, 249, 255], halign: 'right' } },
        { content: '', styles: { fillColor: [240, 249, 255] } },
        { content: '', styles: { fillColor: [240, 249, 255] } },
        { content: '', styles: { fillColor: [240, 249, 255] } },
        { content: '', styles: { fillColor: [240, 249, 255] } },
        { content: MathParser.formatNumber(item.totalQuantity, 3), styles: { fontStyle: 'bold', fillColor: [240, 249, 255], halign: 'right' } },
        { content: MathParser.formatCurrency(item.totalAmount).replace('Rs. ', ''), styles: { fontStyle: 'bold', fillColor: [240, 249, 255], halign: 'right' } }
      ]);

      (item.subRows || []).forEach(sub => {
        tableData.push([
          '',
          sub.subDescription || '-',
          '',
          '',
          MathParser.formatNumber(sub.nosEvaluated, 3),
          MathParser.formatNumber(sub.lengthEvaluated, 3),
          MathParser.formatNumber(sub.breadthEvaluated, 3),
          MathParser.formatNumber(sub.heightEvaluated, 3),
          { content: MathParser.formatNumber(sub.quantity, 3), styles: { halign: 'right' } },
          { content: MathParser.formatCurrency(sub.amount).replace('Rs. ', ''), styles: { halign: 'right' } }
        ]);
      });

      grandTotalQty += item.totalQuantity || 0;
      grandTotalAmt += item.totalAmount || 0;
    });

    tableData.push([
      { content: '', colSpan: 8, styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } }
    ]);
    tableData.push([
      { content: 'GRAND TOTAL', colSpan: 8, styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
      { content: MathParser.formatNumber(grandTotalQty, 3), styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'right' } },
      { content: MathParser.formatCurrency(grandTotalAmt).replace('Rs. ', ''), styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'right' } }
    ]);

    doc.autoTable({
      startY: startY,
      head: [['Item No', 'Description', 'Unit', 'Rate (Rs.)', 'Nos', 'Length', 'Breadth', 'Height', 'Qty', 'Amount (Rs.)']],
      body: tableData,
      theme: 'grid',
      styles: { fontSize: 7, cellPadding: 1.8, overflow: 'linebreak' },
      headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
      columnStyles: {
        0: { cellWidth: 11 },
        1: { cellWidth: 'auto' },
        2: { cellWidth: 9 },
        3: { cellWidth: 15, halign: 'right' },
        4: { cellWidth: 11, halign: 'right' },
        5: { cellWidth: 13, halign: 'right' },
        6: { cellWidth: 13, halign: 'right' },
        7: { cellWidth: 13, halign: 'right' },
        8: { cellWidth: 15, halign: 'right' },
        9: { cellWidth: 17, halign: 'right' }
      },
      margin: { left: margin, right: margin },
      didDrawPage: (data) => {
        doc.setFontSize(6.5);
        doc.setTextColor(150);
        doc.text(`Nepal Civil Engineering PWA | ${this.getReportTitle(type)} | Page ${data.pageNumber}`, pageWidth / 2, doc.internal.pageSize.getHeight() - 6, { align: 'center' });
      }
    });
  },

  // Progress Comparison PDF
  async renderProgressPDF(doc, project, estimates, measurements, margin, pageWidth, startY) {
    const prog = ProgressEngine.compute(project.id);

    // Summary bar
    doc.setFillColor(248, 250, 252);
    doc.rect(margin, startY, pageWidth - margin * 2, 18, 'F');
    doc.setDrawColor(200);
    doc.rect(margin, startY, pageWidth - margin * 2, 18, 'S');

    const colW = (pageWidth - margin * 2) / 4;
    const summaryItems = [
      ['Est. Value', MathParser.formatCurrency(prog.totalEstAmt)],
      ['Exec. Value', MathParser.formatCurrency(prog.totalMeasAmt)],
      ['Physical %', prog.overallProgress.toFixed(2) + '%'],
      ['Financial %', prog.financialProgress.toFixed(2) + '%']
    ];

    summaryItems.forEach(([label, val], i) => {
      const x = margin + colW * i + colW / 2;
      doc.setFontSize(7);
      doc.setTextColor(100);
      doc.setFont('helvetica', 'normal');
      doc.text(label, x, startY + 6, { align: 'center' });
      doc.setFontSize(9);
      doc.setTextColor(30);
      doc.setFont('helvetica', 'bold');
      doc.text(val, x, startY + 13, { align: 'center' });
    });

    startY += 22;

    // Comparison table
    const tableData = prog.rows.map(r => {
      const barWidth = 25;
      const fillW = Math.min(r.progress, 100) / 100 * barWidth;

      let barColor = [239, 68, 68]; // red
      if (r.progress >= 100) barColor = [34, 197, 94]; // green
      else if (r.progress > 0) barColor = [14, 165, 233]; // blue

      return [
        r.itemNo,
        r.description,
        r.unit,
        MathParser.formatNumber(r.rate, 2),
        { content: MathParser.formatNumber(r.estQty, 3), styles: { halign: 'right' } },
        { content: MathParser.formatNumber(r.estAmt, 2), styles: { halign: 'right' } },
        { content: MathParser.formatNumber(r.measQty, 3), styles: { halign: 'right' } },
        { content: MathParser.formatNumber(r.measAmt, 2), styles: { halign: 'right' } },
        { content: (r.varQty > 0 ? '+' : '') + MathParser.formatNumber(r.varQty, 3), styles: { halign: 'right', textColor: r.varQty > 0 ? 239 : r.varQty < 0 ? 245 : 34 } },
        { content: (r.varAmt > 0 ? '+' : '') + MathParser.formatNumber(r.varAmt, 2), styles: { halign: 'right', textColor: r.varAmt > 0 ? 239 : r.varAmt < 0 ? 245 : 34 } },
        { content: r.progress.toFixed(1) + '%', styles: { halign: 'center', fontStyle: 'bold', textColor: barColor } },
        r.status
      ];
    });

    // Grand total row
    tableData.push([
      { content: '', colSpan: 4, styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } },
      { content: '', styles: { fillColor: [15, 23, 42] } }
    ]);
    tableData.push([
      { content: 'GRAND TOTAL', colSpan: 4, styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
      { content: MathParser.formatNumber(prog.totalEstQty, 3), styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'right' } },
      { content: MathParser.formatNumber(prog.totalEstAmt, 2), styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'right' } },
      { content: MathParser.formatNumber(prog.totalMeasQty, 3), styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'right' } },
      { content: MathParser.formatNumber(prog.totalMeasAmt, 2), styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'right' } },
      { content: (prog.totalMeasQty - prog.totalEstQty) > 0 ? '+' : '' + MathParser.formatNumber(prog.totalMeasQty - prog.totalEstQty, 3), styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'right' } },
      { content: (prog.totalMeasAmt - prog.totalEstAmt) > 0 ? '+' : '' + MathParser.formatNumber(prog.totalMeasAmt - prog.totalEstAmt, 2), styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'right' } },
      { content: prog.overallProgress.toFixed(1) + '%', styles: { fontStyle: 'bold', fillColor: [248, 250, 252], halign: 'center' } },
      { content: prog.overallProgress >= 100 ? 'Completed' : prog.overallProgress > 0 ? 'In Progress' : 'Not Started', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } }
    ]);

    doc.autoTable({
      startY: startY,
      head: [['Item', 'Description', 'Unit', 'Rate', 'Est.Qty', 'Est.Amt', 'Meas.Qty', 'Meas.Amt', 'Var.Qty', 'Var.Amt', 'Progress', 'Status']],
      body: tableData,
      theme: 'grid',
      styles: { fontSize: 6.5, cellPadding: 1.5, overflow: 'linebreak' },
      headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold', fontSize: 6.5 },
      columnStyles: {
        0: { cellWidth: 10 },
        1: { cellWidth: 'auto' },
        2: { cellWidth: 8 },
        3: { cellWidth: 12, halign: 'right' },
        4: { cellWidth: 12, halign: 'right' },
        5: { cellWidth: 13, halign: 'right' },
        6: { cellWidth: 12, halign: 'right' },
        7: { cellWidth: 13, halign: 'right' },
        8: { cellWidth: 12, halign: 'right' },
        9: { cellWidth: 13, halign: 'right' },
        10: { cellWidth: 11, halign: 'center' },
        11: { cellWidth: 22 }
      },
      margin: { left: margin, right: margin },
      didDrawPage: (data) => {
        doc.setFontSize(6.5);
        doc.setTextColor(150);
        doc.text(`Nepal Civil Engineering PWA | WORK PROGRESS REPORT | Page ${data.pageNumber}`, pageWidth / 2, doc.internal.pageSize.getHeight() - 6, { align: 'center' });
      }
    });
  },

  // ============================================
  // EXCEL GENERATOR
  // ============================================
  async generateExcel(project, items, type, measurements = []) {
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();

    // === Sheet 1: Summary ===
    const summaryData = [
      ['NEPAL CIVIL ENGINEERING PWA'],
      [this.getReportTitle(type).toUpperCase()],
      [this.getReportSubtitle(type)],
      [],
      ['Project Name', project.name],
      ['Location', project.location],
      ['Budget Head', project.budgetHead],
      ['Total Allocation', project.totalAllocation || 0],
      ['Date of Commencement', project.dateOfCommencement],
      ['Contractor Details', project.contractorDetails],
      [],
      ['Generated On', new Date().toLocaleString()]
    ];

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary['!cols'] = [25, 50].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    if (type === 'progress') {
      await this.generateProgressExcel(wb, project, items, measurements);
    } else {
      await this.generateStandardExcel(wb, items, type);
    }

    XLSX.writeFile(wb, `${project.name}_${type}_${new Date().toISOString().split('T')[0]}.xlsx`);
    showToast('Excel exported successfully', 'success');
  },

  async generateStandardExcel(wb, items, type) {
    const XLSX = window.XLSX;

    // === Sheet 2: Detailed Breakdown ===
    const detailData = [
      ['Item No', 'Description', 'Unit', 'Rate', 'Sub-Description', 'Nos', 'Length', 'Breadth', 'Height', 'Quantity', 'Amount']
    ];

    items.forEach(item => {
      (item.subRows || []).forEach(sub => {
        detailData.push([
          item.itemNo,
          item.description,
          item.unit,
          item.sanctionedRate,
          sub.subDescription || '-',
          sub.nosEvaluated || 0,
          sub.lengthEvaluated || 0,
          sub.breadthEvaluated || 0,
          sub.heightEvaluated || 0,
          sub.quantity || 0,
          sub.amount || 0
        ]);
      });
    });

    const wsDetail = XLSX.utils.aoa_to_sheet(detailData);
    wsDetail['!cols'] = [10, 30, 8, 12, 25, 10, 12, 12, 12, 12, 14].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsDetail, 'Detailed Breakdown');

    // === Sheet 3: Item Totals ===
    const totalsData = [
      ['Item No', 'Description', 'Unit', 'Rate', 'Total Quantity', 'Total Amount']
    ];

    items.forEach(item => {
      totalsData.push([
        item.itemNo,
        item.description,
        item.unit,
        item.sanctionedRate,
        item.totalQuantity || 0,
        item.totalAmount || 0
      ]);
    });

    const wsTotals = XLSX.utils.aoa_to_sheet(totalsData);
    wsTotals['!cols'] = [10, 35, 8, 12, 15, 15].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsTotals, 'Item Totals');
  },

  async generateProgressExcel(wb, project, estimates, measurements) {
    const XLSX = window.XLSX;
    const prog = ProgressEngine.compute(project.id);

    // === Sheet 2: Progress Comparison ===
    const progressData = [
      ['Item No', 'Description', 'Unit', 'Rate (Rs.)', 'Est.Qty', 'Est.Amt (Rs.)', 'Meas.Qty', 'Meas.Amt (Rs.)', 'Var.Qty', 'Var.Amt (Rs.)', 'Progress %', 'Status']
    ];

    prog.rows.forEach(r => {
      progressData.push([
        r.itemNo,
        r.description,
        r.unit,
        r.rate,
        r.estQty,
        r.estAmt,
        r.measQty,
        r.measAmt,
        r.varQty,
        r.varAmt,
        r.progress,
        r.status
      ]);
    });

    // Grand total
    progressData.push([]);
    progressData.push([
      'GRAND TOTAL', '', '', '',
      prog.totalEstQty,
      prog.totalEstAmt,
      prog.totalMeasQty,
      prog.totalMeasAmt,
      prog.totalMeasQty - prog.totalEstQty,
      prog.totalMeasAmt - prog.totalEstAmt,
      prog.overallProgress,
      prog.overallProgress >= 100 ? 'Completed' : prog.overallProgress > 0 ? 'In Progress' : 'Not Started'
    ]);

    const wsProgress = XLSX.utils.aoa_to_sheet(progressData);
    wsProgress['!cols'] = [10, 30, 8, 12, 12, 14, 12, 14, 12, 14, 11, 22].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsProgress, 'Progress Comparison');

    // === Sheet 3: Progress Summary ===
    const summaryData = [
      ['PROGRESS SUMMARY'],
      [],
      ['Metric', 'Value'],
      ['Total Estimated Quantity', prog.totalEstQty],
      ['Total Measured Quantity', prog.totalMeasQty],
      ['Quantity Variance', prog.totalMeasQty - prog.totalEstQty],
      ['Total Estimated Amount (Rs.)', prog.totalEstAmt],
      ['Total Measured Amount (Rs.)', prog.totalMeasAmt],
      ['Amount Variance (Rs.)', prog.totalMeasAmt - prog.totalEstAmt],
      ['Overall Physical Progress %', prog.overallProgress],
      ['Financial Completion %', prog.financialProgress],
      ['Project Allocation (Rs.)', project.totalAllocation || 0],
      ['Budget Utilization %', project.totalAllocation > 0 ? (prog.totalMeasAmt / project.totalAllocation * 100).toFixed(2) : 0]
    ];

    const wsSummary2 = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary2['!cols'] = [30, 20].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsSummary2, 'Progress Summary');
  }
};


// ============================================
// UI RENDERERS
// ============================================
const UI = {
  root: null,

  init() {
    this.root = document.getElementById('app-root');
    this.render();
  },

  render() {
    if (AppState.view === 'dashboard') {
      this.renderDashboard();
    } else if (AppState.view === 'project') {
      this.renderProject();
    }
  },

  // ============================================
  // DASHBOARD
  // ============================================
  async renderDashboard() {
    await AppState.loadProjects();

    this.root.innerHTML = `
      <div class="app-header no-print">
        <h1><i class="fas fa-hard-hat"></i> Nepal Civil Engineering PWA</h1>
        <button class="btn btn-primary" onclick="UI.openProjectModal()">
          <i class="fas fa-plus"></i> New Project
        </button>
      </div>
      <div class="app-main">
        <div class="dashboard-hero">
          <h1>🏗️ Civil Engineering Management</h1>
          <p>Offline-first estimate, measurement & progress tracking</p>
          <div class="credit-badge">
            <i class="fas fa-drafting-compass"></i>
            Envision by Er Neeraj Tandan Chhetri
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
          <h2 style="margin:0; font-size:1.25rem; font-weight:700;">Projects</h2>
          <div class="input-group" style="max-width:300px;">
            <input type="file" id="import-file" accept=".csv,.xlsx,.xls" style="display:none;" onchange="UI.handleImport(this)">
            <button class="btn btn-secondary btn-sm" onclick="document.getElementById('import-file').click()">
              <i class="fas fa-file-import"></i> Import
            </button>
          </div>
        </div>

        ${AppState.projects.length === 0 ? `
          <div class="empty-state">
            <i class="fas fa-folder-open"></i>
            <h3>No Projects Yet</h3>
            <p>Create your first project to get started with estimates and measurements.</p>
            <button class="btn btn-primary mt-3" onclick="UI.openProjectModal()">
              <i class="fas fa-plus"></i> Create Project
            </button>
          </div>
        ` : `
          <div class="project-grid">
            ${AppState.projects.map(p => `
              <div class="project-card" onclick="UI.openProject('${p.id}')">
                <div class="project-title">${Utils.escapeHtml(p.name)}</div>
                <div class="project-meta">
                  <span><i class="fas fa-map-marker-alt"></i> ${Utils.escapeHtml(p.location || 'No location')}</span>
                  <span><i class="fas fa-wallet"></i> Budget Head: ${Utils.escapeHtml(p.budgetHead || '-')}</span>
                  <span><i class="fas fa-calendar"></i> ${Utils.formatDate(p.dateOfCommencement)}</span>
                </div>
                <div class="project-actions no-print" onclick="event.stopPropagation()">
                  <button class="btn btn-secondary btn-sm" onclick="UI.editProject('${p.id}')">
                    <i class="fas fa-edit"></i> Edit
                  </button>
                  <button class="btn btn-danger btn-sm" onclick="UI.deleteProject('${p.id}')">
                    <i class="fas fa-trash"></i> Delete
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;
  },

  // ============================================
  // PROJECT WORKSPACE
  // ============================================
  async renderProject() {
    await AppState.loadProjectData(AppState.projectId);
    const p = AppState.currentProject;

    this.root.innerHTML = `
      <div class="app-header no-print">
        <div style="display:flex; align-items:center; gap:1rem;">
          <button class="btn btn-icon btn-secondary" onclick="UI.goDashboard()" title="Back to Dashboard">
            <i class="fas fa-arrow-left"></i>
          </button>
          <div>
            <h1 style="font-size:1rem; margin:0;">${Utils.escapeHtml(p.name)}</h1>
            <div style="font-size:0.75rem; opacity:0.8;">${Utils.escapeHtml(p.location || '')}</div>
          </div>
        </div>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-secondary btn-sm" onclick="UI.saveProjectData()">
            <i class="fas fa-save"></i> Save
          </button>
        </div>
      </div>
      <div class="app-main">
        <div class="nav-tabs no-print">
          <button class="nav-tab ${AppState.tab === 'setup' ? 'active' : ''}" onclick="UI.switchTab('setup')">
            <i class="fas fa-cog"></i> Setup
          </button>
          <button class="nav-tab ${AppState.tab === 'estimate' ? 'active' : ''}" onclick="UI.switchTab('estimate')">
            <i class="fas fa-calculator"></i> Estimate
          </button>
          <button class="nav-tab ${AppState.tab === 'measurement' ? 'active' : ''}" onclick="UI.switchTab('measurement')">
            <i class="fas fa-ruler-combined"></i> Measurement
          </button>
          <button class="nav-tab ${AppState.tab === 'progress' ? 'active' : ''}" onclick="UI.switchTab('progress')">
            <i class="fas fa-chart-bar"></i> Progress
          </button>
          <button class="nav-tab ${AppState.tab === 'export' ? 'active' : ''}" onclick="UI.switchTab('export')">
            <i class="fas fa-file-export"></i> Export
          </button>
        </div>

        <div id="tab-content"></div>
      </div>
    `;

    this.renderTab();
  },

  renderTab() {
    const container = document.getElementById('tab-content');
    if (!container) return;

    switch(AppState.tab) {
      case 'setup': this.renderSetupTab(container); break;
      case 'estimate': this.renderEstimateTab(container); break;
      case 'measurement': this.renderMeasurementTab(container); break;
      case 'progress': this.renderProgressTab(container); break;
      case 'export': this.renderExportTab(container); break;
    }
  },

  // ============================================
  // SETUP TAB
  // ============================================
  renderSetupTab(container) {
    const p = AppState.currentProject;
    const lh = p.letterhead || {};

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-project-diagram"></i> Project Details</h3>
        </div>
        <div class="card-body">
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:1rem;">
            <div class="form-group">
              <label class="form-label">Project Name *</label>
              <input type="text" class="form-input" id="setup-name" value="${Utils.escapeHtml(p.name || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Location</label>
              <input type="text" class="form-input" id="setup-location" value="${Utils.escapeHtml(p.location || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Budget Head Number</label>
              <input type="text" class="form-input" id="setup-budget" value="${Utils.escapeHtml(p.budgetHead || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Total Allocation (Rs.)</label>
              <input type="number" class="form-input" id="setup-allocation" value="${p.totalAllocation || ''}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Date of Commencement</label>
              <input type="date" class="form-input" id="setup-date" value="${p.dateOfCommencement || ''}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Contractor Details</label>
              <input type="text" class="form-input" id="setup-contractor" value="${Utils.escapeHtml(p.contractorDetails || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Project ID</label>
              <input type="text" class="form-input" id="setup-projectid" value="${Utils.escapeHtml(p.projectId || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
          </div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-header">
          <h3><i class="fas fa-file-alt"></i> Letterhead Configuration</h3>
        </div>
        <div class="card-body">
          <div class="letterhead-preview">
            ${lh.logo ? `<img src="${lh.logo}" alt="Logo">` : '<i class="fas fa-image" style="font-size:2rem; color:#cbd5e1;"></i>'}
            <div style="font-weight:600; color:#1e293b;">${Utils.escapeHtml(lh.departmentName || 'Department Name')}</div>
            <div style="font-size:0.8125rem; color:#64748b;">${Utils.escapeHtml(lh.officeAddress || 'Office Address')}</div>
            <div style="font-size:0.75rem; color:#94a3b8;">${Utils.escapeHtml(lh.contactInfo || 'Contact Information')}</div>
          </div>

          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:1rem;">
            <div class="form-group">
              <label class="form-label">Organization Logo</label>
              <div class="file-input-wrapper">
                <button class="btn btn-secondary w-full">
                  <i class="fas fa-upload"></i> Upload Logo
                </button>
                <input type="file" accept="image/*" onchange="UI.handleLogoUpload(this)">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Department Name</label>
              <input type="text" class="form-input" id="lh-dept" value="${Utils.escapeHtml(lh.departmentName || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Office Address</label>
              <input type="text" class="form-input" id="lh-address" value="${Utils.escapeHtml(lh.officeAddress || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Contact Info</label>
              <input type="text" class="form-input" id="lh-contact" value="${Utils.escapeHtml(lh.contactInfo || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
            <div class="form-group">
              <label class="form-label">Document Subtitle</label>
              <input type="text" class="form-input" id="lh-subtitle" value="${Utils.escapeHtml(lh.documentSubtitle || '')}" 
                oninput="UI.debouncedSaveSetup()">
            </div>
          </div>
        </div>
      </div>
    `;
  },

  debouncedSaveSetup: Utils.debounce(async function() {
    await UI.saveSetupData();
  }, 800),

  async saveSetupData() {
    const p = AppState.currentProject;
    p.name = document.getElementById('setup-name')?.value || p.name;
    p.location = document.getElementById('setup-location')?.value || '';
    p.budgetHead = document.getElementById('setup-budget')?.value || '';
    p.totalAllocation = parseFloat(document.getElementById('setup-allocation')?.value) || 0;
    p.dateOfCommencement = document.getElementById('setup-date')?.value || '';
    p.contractorDetails = document.getElementById('setup-contractor')?.value || '';
    p.projectId = document.getElementById('setup-projectid')?.value || '';

    p.letterhead = p.letterhead || {};
    p.letterhead.departmentName = document.getElementById('lh-dept')?.value || '';
    p.letterhead.officeAddress = document.getElementById('lh-address')?.value || '';
    p.letterhead.contactInfo = document.getElementById('lh-contact')?.value || '';
    p.letterhead.documentSubtitle = document.getElementById('lh-subtitle')?.value || '';

    p.updatedAt = Date.now();
    await db.projects.put(p);
    showToast('Project details auto-saved', 'success');
  },

  async handleLogoUpload(input) {
    const file = input.files[0];
    if (!file) return;

    const compressed = await PhotoEngine.compressImage(file, 400, 0.8);
    const p = AppState.currentProject;
    p.letterhead = p.letterhead || {};
    p.letterhead.logo = compressed;
    p.updatedAt = Date.now();
    await db.projects.put(p);
    showToast('Logo uploaded', 'success');
    this.renderSetupTab(document.getElementById('tab-content'));
  },


  // ============================================
  // ESTIMATE TAB
  // ============================================
  renderEstimateTab(container) {
    const items = AppState.estimates;

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;" class="no-print">
        <h2 style="margin:0; font-size:1.125rem; font-weight:700;">Cost Estimate</h2>
        <button class="btn btn-primary" onclick="UI.openEstimateItemModal()">
          <i class="fas fa-plus"></i> Add Item
        </button>
      </div>

      ${items.length === 0 ? `
        <div class="empty-state">
          <i class="fas fa-calculator"></i>
          <h3>No Estimate Items</h3>
          <p>Add items with descriptions, units, rates, and dimension calculations.</p>
        </div>
      ` : `
        <div id="estimate-items">
          ${items.map(item => this.renderEstimateItem(item)).join('')}
        </div>

        <div class="card mt-4" style="background:#f8fafc;">
          <div class="card-body" style="display:flex; justify-content:space-between; align-items:center;">
            <span class="font-semibold">Grand Total</span>
            <span class="font-bold text-primary" style="font-size:1.25rem;">
              ${MathParser.formatCurrency(items.reduce((s, i) => s + (i.totalAmount || 0), 0))}
            </span>
          </div>
        </div>
      `}
    `;
  },

  renderEstimateItem(item) {
    const isExpanded = AppState.expandedItems.has(item.id);
    const subRows = item.subRows || [];

    return `
      <div class="item-card" id="est-item-${item.id}">
        <div class="item-header ${isExpanded ? 'expanded' : ''}" onclick="UI.toggleItem('${item.id}')">
          <div class="item-title">
            <span class="item-number">${Utils.escapeHtml(item.itemNo)}</span>
            <span>${Utils.escapeHtml(item.description)}</span>
            <span style="color:#64748b; font-size:0.8125rem; font-weight:400;">
              (${Utils.escapeHtml(item.unit)} @ Rs. ${MathParser.formatNumber(item.sanctionedRate, 2)})
            </span>
          </div>
          <div class="item-meta">
            <span class="font-semibold">${MathParser.formatCurrency(item.totalAmount || 0)}</span>
            <span>Qty: ${MathParser.formatNumber(item.totalQuantity || 0, 3)}</span>
            <span style="font-size:0.75rem;"><i class="fas fa-chevron-${isExpanded ? 'up' : 'down'}"></i></span>
          </div>
        </div>

        ${isExpanded ? `
          <div class="item-body">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;" class="no-print">
              <span style="font-size:0.8125rem; color:#64748b;">${subRows.length} sub-row(s)</span>
              <div style="display:flex; gap:0.5rem;">
                <button class="btn btn-secondary btn-sm" onclick="UI.addEstimateSubRow('${item.id}')">
                  <i class="fas fa-plus"></i> Add Sub-Row
                </button>
                <button class="btn btn-danger btn-sm" onclick="UI.deleteEstimateItem('${item.id}')">
                  <i class="fas fa-trash"></i> Delete Item
                </button>
              </div>
            </div>

            ${subRows.map((sub, idx) => this.renderEstimateSubRow(item, sub, idx)).join('')}

            ${subRows.length === 0 ? `
              <div class="text-center" style="padding:2rem; color:#94a3b8;">
                <i class="fas fa-layer-group" style="font-size:2rem; margin-bottom:0.5rem;"></i>
                <p>No sub-rows yet. Add one to enter dimensions.</p>
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
  },

  renderEstimateSubRow(item, sub, idx) {
    const photos = PhotoEngine.getPhotosForSubRow(sub.id);

    return `
      <div class="sub-row" id="est-sub-${sub.id}">
        <div class="sub-row-header">
          <div style="flex:1;">
            <input type="text" class="form-input" style="font-size:0.875rem; padding:0.5rem 0.75rem;" 
              placeholder="Sub-description (e.g., Foundation Bay A)"
              value="${Utils.escapeHtml(sub.subDescription || '')}"
              onchange="UI.updateEstimateSubRow('${item.id}', '${sub.id}', 'subDescription', this.value)">
          </div>
          <button class="btn btn-danger btn-sm btn-icon" onclick="UI.deleteEstimateSubRow('${item.id}', '${sub.id}')">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="dimension-grid">
          <div class="dimension-field">
            <label>Nos (Quantity)</label>
            <input type="text" class="table-input font-mono" placeholder="1"
              value="${Utils.escapeHtml(sub.nos || '')}"
              oninput="UI.updateEstimateDimension('${item.id}', '${sub.id}', 'nos', this.value)">
            <div class="evaluated">= ${MathParser.formatNumber(sub.nosEvaluated, 3)}</div>
          </div>
          <div class="dimension-field">
            <label>Length</label>
            <input type="text" class="table-input font-mono" placeholder="0"
              value="${Utils.escapeHtml(sub.length || '')}"
              oninput="UI.updateEstimateDimension('${item.id}', '${sub.id}', 'length', this.value)">
            <div class="evaluated">= ${MathParser.formatNumber(sub.lengthEvaluated, 3)} m</div>
          </div>
          <div class="dimension-field">
            <label>Breadth</label>
            <input type="text" class="table-input font-mono" placeholder="0"
              value="${Utils.escapeHtml(sub.breadth || '')}"
              oninput="UI.updateEstimateDimension('${item.id}', '${sub.id}', 'breadth', this.value)">
            <div class="evaluated">= ${MathParser.formatNumber(sub.breadthEvaluated, 3)} m</div>
          </div>
          <div class="dimension-field">
            <label>Height / Depth</label>
            <input type="text" class="table-input font-mono" placeholder="0"
              value="${Utils.escapeHtml(sub.height || '')}"
              oninput="UI.updateEstimateDimension('${item.id}', '${sub.id}', 'height', this.value)">
            <div class="evaluated">= ${MathParser.formatNumber(sub.heightEvaluated, 3)} m</div>
          </div>
          <div class="dimension-field">
            <label>Quantity</label>
            <div style="padding:0.375rem 0; font-weight:700; color:#0ea5e9;">
              ${MathParser.formatNumber(sub.quantity, 3)} ${Utils.escapeHtml(item.unit)}
            </div>
          </div>
          <div class="dimension-field">
            <label>Amount</label>
            <div style="padding:0.375rem 0; font-weight:700; color:#22c55e;">
              ${MathParser.formatCurrency(sub.amount)}
            </div>
          </div>
        </div>

        <div style="margin-top:0.75rem;">
          <div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.5rem;">
            <span style="font-size:0.8125rem; font-weight:500; color:#475569;">
              <i class="fas fa-camera"></i> Photos (${photos.length})
            </span>
            <div class="file-input-wrapper">
              <button class="btn btn-secondary btn-sm">
                <i class="fas fa-plus"></i> Add Photo
              </button>
              <input type="file" accept="image/*" capture="environment"
                onchange="UI.addPhotoToSubRow(this, '${item.id}', '${sub.id}', 'estimate')">
            </div>
          </div>

          ${photos.length > 0 ? `
            <div class="photo-grid">
              ${photos.map(photo => `
                <div class="photo-thumb" onclick="UI.openLightbox('${photo.id}')">
                  <img src="${photo.data}" alt="${Utils.escapeHtml(photo.caption || 'Photo')}">
                  ${photo.geotag ? `<div class="photo-caption"><i class="fas fa-map-marker-alt"></i> Tagged</div>` : ''}
                  <button class="photo-delete" onclick="event.stopPropagation(); UI.deletePhoto('${photo.id}')">×</button>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  },

  // ============================================
  // ESTIMATE DATA OPERATIONS
  // ============================================
  async openEstimateItemModal(editId = null) {
    const editItem = editId ? AppState.estimates.find(e => e.id === editId) : null;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.id = 'estimate-item-modal';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${editItem ? 'Edit' : 'Add'} Estimate Item</h3>
          <button class="modal-close" onclick="document.getElementById('estimate-item-modal').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Item Number *</label>
            <input type="text" class="form-input" id="est-modal-no" value="${editItem ? Utils.escapeHtml(editItem.itemNo) : ''}" placeholder="e.g., 1, 2.1, 3.a">
          </div>
          <div class="form-group">
            <label class="form-label">Description *</label>
            <input type="text" class="form-input" id="est-modal-desc" value="${editItem ? Utils.escapeHtml(editItem.description) : ''}" placeholder="e.g., Earthwork in Excavation">
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
            <div class="form-group">
              <label class="form-label">Unit *</label>
              <select class="form-select" id="est-modal-unit">
                <option value="">Select unit...</option>
                <option value="m³" ${editItem?.unit === 'm³' ? 'selected' : ''}>m³ (Cubic Meter)</option>
                <option value="m²" ${editItem?.unit === 'm²' ? 'selected' : ''}>m² (Square Meter)</option>
                <option value="m" ${editItem?.unit === 'm' ? 'selected' : ''}>m (Meter)</option>
                <option value="nos" ${editItem?.unit === 'nos' ? 'selected' : ''}>nos (Numbers)</option>
                <option value="kg" ${editItem?.unit === 'kg' ? 'selected' : ''}>kg (Kilogram)</option>
                <option value="ton" ${editItem?.unit === 'ton' ? 'selected' : ''}>ton (Tonne)</option>
                <option value="hr" ${editItem?.unit === 'hr' ? 'selected' : ''}>hr (Hour)</option>
                <option value="day" ${editItem?.unit === 'day' ? 'selected' : ''}>day (Day)</option>
                <option value="lump sum" ${editItem?.unit === 'lump sum' ? 'selected' : ''}>Lump Sum</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Sanctioned Rate (Rs.) *</label>
              <input type="number" class="form-input" id="est-modal-rate" value="${editItem ? editItem.sanctionedRate : ''}" placeholder="0.00" step="0.01">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('estimate-item-modal').remove()">Cancel</button>
          <button class="btn btn-primary" onclick="UI.saveEstimateItem('${editId || ''}')">
            ${editItem ? 'Update' : 'Create'} Item
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  },

  async saveEstimateItem(editId) {
    const itemNo = document.getElementById('est-modal-no').value.trim();
    const description = document.getElementById('est-modal-desc').value.trim();
    const unit = document.getElementById('est-modal-unit').value;
    const rate = parseFloat(document.getElementById('est-modal-rate').value) || 0;

    if (!itemNo || !description || !unit) {
      showToast('Please fill all required fields', 'error');
      return;
    }

    let item;
    if (editId) {
      item = AppState.estimates.find(e => e.id === editId);
      item.itemNo = itemNo;
      item.description = description;
      item.unit = unit;
      item.sanctionedRate = rate;
      item.updatedAt = Date.now();
    } else {
      item = {
        id: Utils.generateId(),
        projectId: AppState.projectId,
        itemNo,
        description,
        unit,
        sanctionedRate: rate,
        subRows: [],
        totalQuantity: 0,
        totalAmount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      AppState.estimates.push(item);
    }

    await db.estimateItems.put(item);

    if (!editId) {
      await this.createMeasurementItem(item);
    } else {
      const meas = AppState.measurements.find(m => m.estimateItemId === item.id);
      if (meas) {
        meas.itemNo = itemNo;
        meas.description = description;
        meas.unit = unit;
        meas.sanctionedRate = rate;
        meas.updatedAt = Date.now();
        await db.measurementItems.put(meas);
      }
    }

    document.getElementById('estimate-item-modal').remove();
    showToast(editId ? 'Item updated' : 'Item created', 'success');
    this.renderEstimateTab(document.getElementById('tab-content'));
  },

  async createMeasurementItem(estimateItem) {
    const measItem = {
      id: Utils.generateId(),
      projectId: estimateItem.projectId,
      estimateItemId: estimateItem.id,
      itemNo: estimateItem.itemNo,
      description: estimateItem.description,
      unit: estimateItem.unit,
      sanctionedRate: estimateItem.sanctionedRate,
      subRows: [],
      totalQuantity: 0,
      totalAmount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    AppState.measurements.push(measItem);
    await db.measurementItems.add(measItem);
  },

  async deleteEstimateItem(itemId) {
    if (!confirm('Delete this item and all its sub-rows?')) return;

    await db.estimateItems.delete(itemId);
    await db.photos.where({ itemId, type: 'estimate' }).delete();

    AppState.estimates = AppState.estimates.filter(e => e.id !== itemId);
    AppState.photos = AppState.photos.filter(p => !(p.itemId === itemId && p.type === 'estimate'));

    showToast('Item deleted', 'success');
    this.renderEstimateTab(document.getElementById('tab-content'));
  },

  async addEstimateSubRow(itemId) {
    const item = AppState.estimates.find(e => e.id === itemId);
    if (!item) return;

    const subRow = {
      id: Utils.generateId(),
      projectId: AppState.projectId,
      estimateItemId: itemId,
      subDescription: '',
      nos: '1',
      nosEvaluated: 1,
      length: '',
      lengthEvaluated: 0,
      breadth: '',
      breadthEvaluated: 0,
      height: '',
      heightEvaluated: 0,
      quantity: 0,
      amount: 0,
      photos: [],
      createdAt: Date.now()
    };

    item.subRows = item.subRows || [];
    item.subRows.push(subRow);
    await db.estimateItems.put(item);

    const measItem = AppState.measurements.find(m => m.estimateItemId === itemId);
    if (measItem) {
      const measSubRow = Utils.deepClone(subRow);
      measSubRow.id = Utils.generateId();
      measSubRow.estimateItemId = undefined;
      measSubRow.measurementItemId = measItem.id;
      measSubRow.projectId = AppState.projectId;
      measSubRow.nos = '';
      measSubRow.nosEvaluated = 0;
      measSubRow.length = '';
      measSubRow.lengthEvaluated = 0;
      measSubRow.breadth = '';
      measSubRow.breadthEvaluated = 0;
      measSubRow.height = '';
      measSubRow.heightEvaluated = 0;
      measSubRow.quantity = 0;
      measSubRow.amount = 0;
      measSubRow.photos = [];

      measItem.subRows = measItem.subRows || [];
      measItem.subRows.push(measSubRow);
      await db.measurementItems.put(measItem);
    }

    this.renderEstimateTab(document.getElementById('tab-content'));
    AppState.expandedItems.add(itemId);
  },

  async deleteEstimateSubRow(itemId, subRowId) {
    const item = AppState.estimates.find(e => e.id === itemId);
    if (!item) return;

    item.subRows = item.subRows.filter(s => s.id !== subRowId);
    await this.recalculateEstimateItem(item);
    await db.estimateItems.put(item);

    const photosToDelete = AppState.photos.filter(p => p.subRowId === subRowId && p.type === 'estimate');
    for (const p of photosToDelete) await PhotoEngine.deletePhoto(p.id);

    this.renderEstimateTab(document.getElementById('tab-content'));
  },

  async updateEstimateSubRow(itemId, subRowId, field, value) {
    const item = AppState.estimates.find(e => e.id === itemId);
    if (!item) return;
    const sub = item.subRows.find(s => s.id === subRowId);
    if (!sub) return;
    sub[field] = value;
    await db.estimateItems.put(item);
  },

  async updateEstimateDimension(itemId, subRowId, field, value) {
    const item = AppState.estimates.find(e => e.id === itemId);
    if (!item) return;
    const sub = item.subRows.find(s => s.id === subRowId);
    if (!sub) return;

    sub[field] = value;
    sub[field + 'Evaluated'] = MathParser.evaluate(value);

    const nos = sub.nosEvaluated || 0;
    const len = sub.lengthEvaluated || 0;
    const brd = sub.breadthEvaluated || 0;
    const hgt = sub.heightEvaluated || 0;

    if (item.unit === 'm³') sub.quantity = nos * len * brd * hgt;
    else if (item.unit === 'm²') sub.quantity = nos * len * brd;
    else if (item.unit === 'm') sub.quantity = nos * len;
    else sub.quantity = nos;

    sub.amount = sub.quantity * (item.sanctionedRate || 0);

    await this.recalculateEstimateItem(item);
    await db.estimateItems.put(item);

    const qtyEl = document.querySelector(`#est-sub-${subRowId} .dimension-field:nth-child(5) div`);
    const amtEl = document.querySelector(`#est-sub-${subRowId} .dimension-field:nth-child(6) div`);
    const evalEl = document.querySelector(`#est-sub-${subRowId} .dimension-field:nth-child(${field === 'nos' ? 1 : field === 'length' ? 2 : field === 'breadth' ? 3 : 4}) .evaluated`);

    if (qtyEl) qtyEl.textContent = `${MathParser.formatNumber(sub.quantity, 3)} ${item.unit}`;
    if (amtEl) amtEl.textContent = MathParser.formatCurrency(sub.amount);
    if (evalEl) evalEl.textContent = `= ${MathParser.formatNumber(sub[field + 'Evaluated'], 3)}${field !== 'nos' ? ' m' : ''}`;

    const itemHeader = document.querySelector(`#est-item-${itemId} .item-meta`);
    if (itemHeader) {
      itemHeader.innerHTML = `
        <span class="font-semibold">${MathParser.formatCurrency(item.totalAmount || 0)}</span>
        <span>Qty: ${MathParser.formatNumber(item.totalQuantity || 0, 3)}</span>
        <span style="font-size:0.75rem;"><i class="fas fa-chevron-up"></i></span>
      `;
    }

    const grandTotal = AppState.estimates.reduce((s, i) => s + (i.totalAmount || 0), 0);
    const grandEl = document.querySelector('.card.mt-4 .text-primary');
    if (grandEl) grandEl.textContent = MathParser.formatCurrency(grandTotal);
  },

  async recalculateEstimateItem(item) {
    item.totalQuantity = (item.subRows || []).reduce((sum, s) => sum + (s.quantity || 0), 0);
    item.totalAmount = (item.subRows || []).reduce((sum, s) => sum + (s.amount || 0), 0);
    item.updatedAt = Date.now();
  },

  toggleItem(itemId) {
    if (AppState.expandedItems.has(itemId)) {
      AppState.expandedItems.delete(itemId);
    } else {
      AppState.expandedItems.add(itemId);
    }
    this.renderEstimateTab(document.getElementById('tab-content'));
  },


  // ============================================
  // MEASUREMENT TAB
  // ============================================
  renderMeasurementTab(container) {
    const items = AppState.measurements;

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;" class="no-print">
        <h2 style="margin:0; font-size:1.125rem; font-weight:700;">Measurement Book</h2>
        <span style="font-size:0.8125rem; color:#64748b;">
          <i class="fas fa-sync"></i> Auto-synced with Estimate
        </span>
      </div>

      ${items.length === 0 ? `
        <div class="empty-state">
          <i class="fas fa-ruler-combined"></i>
          <h3>No Measurement Items</h3>
          <p>Items will appear here automatically when you add them to the Estimate tab.</p>
        </div>
      ` : `
        <div id="measurement-items">
          ${items.map(item => this.renderMeasurementItem(item)).join('')}
        </div>

        <div class="card mt-4" style="background:#f8fafc;">
          <div class="card-body" style="display:flex; justify-content:space-between; align-items:center;">
            <span class="font-semibold">Grand Total</span>
            <span class="font-bold text-primary" style="font-size:1.25rem;">
              ${MathParser.formatCurrency(items.reduce((s, i) => s + (i.totalAmount || 0), 0))}
            </span>
          </div>
        </div>
      `}
    `;
  },

  renderMeasurementItem(item) {
    const isExpanded = AppState.expandedItems.has('meas-' + item.id);
    const subRows = item.subRows || [];
    const estItem = AppState.estimates.find(e => e.id === item.estimateItemId);

    return `
      <div class="item-card" id="meas-item-${item.id}">
        <div class="item-header ${isExpanded ? 'expanded' : ''}" onclick="UI.toggleMeasItem('${item.id}')">
          <div class="item-title">
            <span class="item-number">${Utils.escapeHtml(item.itemNo)}</span>
            <span>${Utils.escapeHtml(item.description)}</span>
            <span style="color:#64748b; font-size:0.8125rem; font-weight:400;">
              (${Utils.escapeHtml(item.unit)} @ Rs. ${MathParser.formatNumber(item.sanctionedRate, 2)})
            </span>
            ${estItem ? `<span style="font-size:0.75rem; color:#94a3b8; margin-left:0.5rem;">
              Est: ${MathParser.formatNumber(estItem.totalQuantity, 3)} ${Utils.escapeHtml(item.unit)}
            </span>` : ''}
          </div>
          <div class="item-meta">
            <span class="font-semibold">${MathParser.formatCurrency(item.totalAmount || 0)}</span>
            <span>Qty: ${MathParser.formatNumber(item.totalQuantity || 0, 3)}</span>
            <span style="font-size:0.75rem;"><i class="fas fa-chevron-${isExpanded ? 'up' : 'down'}"></i></span>
          </div>
        </div>

        ${isExpanded ? `
          <div class="item-body">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;" class="no-print">
              <span style="font-size:0.8125rem; color:#64748b;">${subRows.length} sub-row(s)</span>
              <button class="btn btn-secondary btn-sm" onclick="UI.addMeasurementSubRow('${item.id}')">
                <i class="fas fa-plus"></i> Add Sub-Row
              </button>
            </div>

            ${subRows.map((sub, idx) => this.renderMeasurementSubRow(item, sub, idx, estItem)).join('')}

            ${subRows.length === 0 ? `
              <div class="text-center" style="padding:2rem; color:#94a3b8;">
                <i class="fas fa-layer-group" style="font-size:2rem; margin-bottom:0.5rem;"></i>
                <p>No measurement sub-rows yet. Add one to record actual field measurements.</p>
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
  },

  renderMeasurementSubRow(item, sub, idx, estItem) {
    const photos = PhotoEngine.getPhotosForSubRow(sub.id);
    const estSub = estItem?.subRows?.[idx];

    return `
      <div class="sub-row" id="meas-sub-${sub.id}">
        <div class="sub-row-header">
          <div style="flex:1;">
            <input type="text" class="form-input" style="font-size:0.875rem; padding:0.5rem 0.75rem;" 
              placeholder="Sub-description"
              value="${Utils.escapeHtml(sub.subDescription || '')}"
              onchange="UI.updateMeasurementSubRow('${item.id}', '${sub.id}', 'subDescription', this.value)">
          </div>
          <button class="btn btn-danger btn-sm btn-icon" onclick="UI.deleteMeasurementSubRow('${item.id}', '${sub.id}')">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="dimension-grid">
          <div class="dimension-field">
            <label>Nos (Quantity)</label>
            <input type="text" class="table-input font-mono" placeholder="0"
              value="${Utils.escapeHtml(sub.nos || '')}"
              oninput="UI.updateMeasurementDimension('${item.id}', '${sub.id}', 'nos', this.value)">
            <div class="evaluated">= ${MathParser.formatNumber(sub.nosEvaluated, 3)}</div>
            ${estSub ? `<div style="font-size:0.6875rem; color:#94a3b8; margin-top:2px;">Est: ${MathParser.formatNumber(estSub.nosEvaluated, 3)}</div>` : ''}
          </div>
          <div class="dimension-field">
            <label>Length</label>
            <input type="text" class="table-input font-mono" placeholder="0"
              value="${Utils.escapeHtml(sub.length || '')}"
              oninput="UI.updateMeasurementDimension('${item.id}', '${sub.id}', 'length', this.value)">
            <div class="evaluated">= ${MathParser.formatNumber(sub.lengthEvaluated, 3)} m</div>
            ${estSub ? `<div style="font-size:0.6875rem; color:#94a3b8; margin-top:2px;">Est: ${MathParser.formatNumber(estSub.lengthEvaluated, 3)} m</div>` : ''}
          </div>
          <div class="dimension-field">
            <label>Breadth</label>
            <input type="text" class="table-input font-mono" placeholder="0"
              value="${Utils.escapeHtml(sub.breadth || '')}"
              oninput="UI.updateMeasurementDimension('${item.id}', '${sub.id}', 'breadth', this.value)">
            <div class="evaluated">= ${MathParser.formatNumber(sub.breadthEvaluated, 3)} m</div>
            ${estSub ? `<div style="font-size:0.6875rem; color:#94a3b8; margin-top:2px;">Est: ${MathParser.formatNumber(estSub.breadthEvaluated, 3)} m</div>` : ''}
          </div>
          <div class="dimension-field">
            <label>Height / Depth</label>
            <input type="text" class="table-input font-mono" placeholder="0"
              value="${Utils.escapeHtml(sub.height || '')}"
              oninput="UI.updateMeasurementDimension('${item.id}', '${sub.id}', 'height', this.value)">
            <div class="evaluated">= ${MathParser.formatNumber(sub.heightEvaluated, 3)} m</div>
            ${estSub ? `<div style="font-size:0.6875rem; color:#94a3b8; margin-top:2px;">Est: ${MathParser.formatNumber(estSub.heightEvaluated, 3)} m</div>` : ''}
          </div>
          <div class="dimension-field">
            <label>Quantity</label>
            <div style="padding:0.375rem 0; font-weight:700; color:#0ea5e9;">
              ${MathParser.formatNumber(sub.quantity, 3)} ${Utils.escapeHtml(item.unit)}
            </div>
            ${estSub ? `<div style="font-size:0.6875rem; color:#94a3b8; margin-top:2px;">Est: ${MathParser.formatNumber(estSub.quantity, 3)}</div>` : ''}
          </div>
          <div class="dimension-field">
            <label>Amount</label>
            <div style="padding:0.375rem 0; font-weight:700; color:#22c55e;">
              ${MathParser.formatCurrency(sub.amount)}
            </div>
            ${estSub ? `<div style="font-size:0.6875rem; color:#94a3b8; margin-top:2px;">Est: ${MathParser.formatCurrency(estSub.amount)}</div>` : ''}
          </div>
        </div>

        <div style="margin-top:0.75rem;">
          <div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.5rem;">
            <span style="font-size:0.8125rem; font-weight:500; color:#475569;">
              <i class="fas fa-camera"></i> Photos (${photos.length})
            </span>
            <div class="file-input-wrapper">
              <button class="btn btn-secondary btn-sm">
                <i class="fas fa-plus"></i> Add Photo
              </button>
              <input type="file" accept="image/*" capture="environment"
                onchange="UI.addPhotoToSubRow(this, '${item.id}', '${sub.id}', 'measurement')">
            </div>
          </div>

          ${photos.length > 0 ? `
            <div class="photo-grid">
              ${photos.map(photo => `
                <div class="photo-thumb" onclick="UI.openLightbox('${photo.id}')">
                  <img src="${photo.data}" alt="${Utils.escapeHtml(photo.caption || 'Photo')}">
                  ${photo.geotag ? `<div class="photo-caption"><i class="fas fa-map-marker-alt"></i> Tagged</div>` : ''}
                  <button class="photo-delete" onclick="event.stopPropagation(); UI.deletePhoto('${photo.id}')">×</button>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  },

  async addMeasurementSubRow(itemId) {
    const item = AppState.measurements.find(m => m.id === itemId);
    if (!item) return;

    const subRow = {
      id: Utils.generateId(),
      projectId: AppState.projectId,
      measurementItemId: itemId,
      subDescription: '',
      nos: '',
      nosEvaluated: 0,
      length: '',
      lengthEvaluated: 0,
      breadth: '',
      breadthEvaluated: 0,
      height: '',
      heightEvaluated: 0,
      quantity: 0,
      amount: 0,
      photos: [],
      createdAt: Date.now()
    };

    item.subRows = item.subRows || [];
    item.subRows.push(subRow);
    await db.measurementItems.put(item);

    this.renderMeasurementTab(document.getElementById('tab-content'));
    AppState.expandedItems.add('meas-' + itemId);
  },

  async deleteMeasurementSubRow(itemId, subRowId) {
    const item = AppState.measurements.find(m => m.id === itemId);
    if (!item) return;

    item.subRows = item.subRows.filter(s => s.id !== subRowId);
    await this.recalculateMeasurementItem(item);
    await db.measurementItems.put(item);

    const photosToDelete = AppState.photos.filter(p => p.subRowId === subRowId && p.type === 'measurement');
    for (const p of photosToDelete) await PhotoEngine.deletePhoto(p.id);

    this.renderMeasurementTab(document.getElementById('tab-content'));
  },

  async updateMeasurementSubRow(itemId, subRowId, field, value) {
    const item = AppState.measurements.find(m => m.id === itemId);
    if (!item) return;
    const sub = item.subRows.find(s => s.id === subRowId);
    if (!sub) return;
    sub[field] = value;
    await db.measurementItems.put(item);
  },

  async updateMeasurementDimension(itemId, subRowId, field, value) {
    const item = AppState.measurements.find(m => m.id === itemId);
    if (!item) return;
    const sub = item.subRows.find(s => s.id === subRowId);
    if (!sub) return;

    sub[field] = value;
    sub[field + 'Evaluated'] = MathParser.evaluate(value);

    const nos = sub.nosEvaluated || 0;
    const len = sub.lengthEvaluated || 0;
    const brd = sub.breadthEvaluated || 0;
    const hgt = sub.heightEvaluated || 0;

    if (item.unit === 'm³') sub.quantity = nos * len * brd * hgt;
    else if (item.unit === 'm²') sub.quantity = nos * len * brd;
    else if (item.unit === 'm') sub.quantity = nos * len;
    else sub.quantity = nos;

    sub.amount = sub.quantity * (item.sanctionedRate || 0);

    await this.recalculateMeasurementItem(item);
    await db.measurementItems.put(item);

    const qtyEl = document.querySelector(`#meas-sub-${subRowId} .dimension-field:nth-child(5) div`);
    const amtEl = document.querySelector(`#meas-sub-${subRowId} .dimension-field:nth-child(6) div`);
    const evalEl = document.querySelector(`#meas-sub-${subRowId} .dimension-field:nth-child(${field === 'nos' ? 1 : field === 'length' ? 2 : field === 'breadth' ? 3 : 4}) .evaluated`);

    if (qtyEl) qtyEl.textContent = `${MathParser.formatNumber(sub.quantity, 3)} ${item.unit}`;
    if (amtEl) amtEl.textContent = MathParser.formatCurrency(sub.amount);
    if (evalEl) evalEl.textContent = `= ${MathParser.formatNumber(sub[field + 'Evaluated'], 3)}${field !== 'nos' ? ' m' : ''}`;

    const itemHeader = document.querySelector(`#meas-item-${itemId} .item-meta`);
    if (itemHeader) {
      itemHeader.innerHTML = `
        <span class="font-semibold">${MathParser.formatCurrency(item.totalAmount || 0)}</span>
        <span>Qty: ${MathParser.formatNumber(item.totalQuantity || 0, 3)}</span>
        <span style="font-size:0.75rem;"><i class="fas fa-chevron-up"></i></span>
      `;
    }

    const grandTotal = AppState.measurements.reduce((s, i) => s + (i.totalAmount || 0), 0);
    const grandEl = document.querySelector('#tab-content .card.mt-4 .text-primary');
    if (grandEl) grandEl.textContent = MathParser.formatCurrency(grandTotal);
  },

  async recalculateMeasurementItem(item) {
    item.totalQuantity = (item.subRows || []).reduce((sum, s) => sum + (s.quantity || 0), 0);
    item.totalAmount = (item.subRows || []).reduce((sum, s) => sum + (s.amount || 0), 0);
    item.updatedAt = Date.now();
  },

  toggleMeasItem(itemId) {
    const key = 'meas-' + itemId;
    if (AppState.expandedItems.has(key)) {
      AppState.expandedItems.delete(key);
    } else {
      AppState.expandedItems.add(key);
    }
    this.renderMeasurementTab(document.getElementById('tab-content'));
  },

  // ============================================
  // PROGRESS TAB (ENHANCED WITH CANVAS CHARTS)
  // ============================================
  renderProgressTab(container) {
    const prog = ProgressEngine.compute(AppState.projectId);
    const project = prog.project;

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
        <h2 style="margin:0; font-size:1.125rem; font-weight:700;">Work Progress Report</h2>
      </div>

      <!-- Summary Stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Allocated Budget</div>
          <div class="stat-value">${MathParser.formatCurrency(project.totalAllocation || 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Estimated Value</div>
          <div class="stat-value">${MathParser.formatCurrency(prog.totalEstAmt)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Executed Value</div>
          <div class="stat-value">${MathParser.formatCurrency(prog.totalMeasAmt)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Overall Physical %</div>
          <div class="stat-value">${prog.overallProgress.toFixed(2)}%</div>
          <div class="progress-bar-container">
            <div class="progress-bar ${prog.overallProgress >= 100 ? 'green' : prog.overallProgress > 0 ? 'blue' : 'red'}" style="width:${Math.min(prog.overallProgress, 100)}%"></div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Financial Completion %</div>
          <div class="stat-value">${prog.financialProgress.toFixed(2)}%</div>
          <div class="progress-bar-container">
            <div class="progress-bar ${prog.financialProgress >= 100 ? 'green' : prog.financialProgress > 0 ? 'blue' : 'red'}" style="width:${Math.min(prog.financialProgress, 100)}%"></div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Variance (Qty)</div>
          <div class="stat-value ${prog.totalMeasQty > prog.totalEstQty ? 'text-danger' : prog.totalMeasQty < prog.totalEstQty ? 'text-warning' : 'text-success'}">
            ${(prog.totalMeasQty - prog.totalEstQty) > 0 ? '+' : ''}${MathParser.formatNumber(prog.totalMeasQty - prog.totalEstQty, 3)}
          </div>
        </div>
      </div>

      <!-- Graphical Comparison Chart -->
      ${prog.rows.length > 0 ? `
        <div class="card mb-4">
          <div class="card-header">
            <h3><i class="fas fa-chart-bar"></i> Estimate vs Measurement Comparison</h3>
          </div>
          <div class="card-body">
            <canvas id="progress-chart" style="width:100%; height:320px;"></canvas>
          </div>
        </div>
      ` : ''}

      <!-- Item-wise Table -->
      <div class="card">
        <div class="card-header">
          <h3>Item-wise Progress Comparison</h3>
        </div>
        <div class="card-body" style="padding:0;">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Item No</th>
                  <th>Description</th>
                  <th class="text-right">Rate (Rs.)</th>
                  <th class="text-right">Est.Qty</th>
                  <th class="text-right">Est.Amt</th>
                  <th class="text-right">Meas.Qty</th>
                  <th class="text-right">Meas.Amt</th>
                  <th class="text-right">Var.Qty</th>
                  <th class="text-right">Var.Amt</th>
                  <th>Progress</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${prog.rows.map(r => `
                  <tr>
                    <td><span class="item-number">${Utils.escapeHtml(r.itemNo)}</span></td>
                    <td>${Utils.escapeHtml(r.description)}</td>
                    <td class="text-right">${MathParser.formatNumber(r.rate, 2)}</td>
                    <td class="text-right">${MathParser.formatNumber(r.estQty, 3)}</td>
                    <td class="text-right">${MathParser.formatNumber(r.estAmt, 2)}</td>
                    <td class="text-right">${MathParser.formatNumber(r.measQty, 3)}</td>
                    <td class="text-right">${MathParser.formatNumber(r.measAmt, 2)}</td>
                    <td class="text-right ${r.varQty > 0 ? 'text-danger' : r.varQty < 0 ? 'text-warning' : 'text-success'}">
                      ${r.varQty > 0 ? '+' : ''}${MathParser.formatNumber(r.varQty, 3)}
                    </td>
                    <td class="text-right ${r.varAmt > 0 ? 'text-danger' : r.varAmt < 0 ? 'text-warning' : 'text-success'}">
                      ${r.varAmt > 0 ? '+' : ''}${MathParser.formatNumber(r.varAmt, 2)}
                    </td>
                    <td style="min-width:140px;">
                      <div class="progress-bar-container">
                        <div class="progress-bar ${r.barColor}" style="width:${Math.min(r.progress, 100)}%"></div>
                      </div>
                      <div style="font-size:0.75rem; color:#64748b; margin-top:2px;">${r.progress.toFixed(1)}%</div>
                    </td>
                    <td>
                      <span style="font-size:0.75rem; padding:0.25rem 0.5rem; border-radius:0.375rem; background:${r.statusBg}; color:${r.statusColor};">
                        ${r.status}
                      </span>
                    </td>
                  </tr>
                `).join('')}
                ${prog.rows.length === 0 ? `
                  <tr>
                    <td colspan="11" class="text-center" style="padding:2rem; color:#94a3b8;">
                      No data available. Add items to Estimate and Measurement tabs first.
                    </td>
                  </tr>
                ` : ''}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Render canvas chart after DOM update
    if (prog.rows.length > 0) {
      setTimeout(() => this.renderProgressChart(prog.rows), 50);
    }
  },

  renderProgressChart(rows) {
    const canvas = document.getElementById('progress-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padding = { top: 40, right: 20, bottom: 80, left: 60 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // Clear
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Find max for scaling
    const maxVal = Math.max(...rows.map(r => Math.max(r.estQty, r.measQty))) || 1;
    const barCount = rows.length;
    const groupWidth = chartW / barCount;
    const barWidth = groupWidth * 0.35;
    const gap = groupWidth * 0.1;

    // Title
    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Quantity Comparison: Estimate vs Measurement', w / 2, 22);

    // Legend
    const legendY = 38;
    ctx.fillStyle = '#0ea5e9';
    ctx.fillRect(w / 2 - 70, legendY - 8, 12, 12);
    ctx.fillStyle = '#64748b';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Estimated', w / 2 - 54, legendY + 2);

    ctx.fillStyle = '#22c55e';
    ctx.fillRect(w / 2 + 10, legendY - 8, 12, 12);
    ctx.fillStyle = '#64748b';
    ctx.fillText('Measured', w / 2 + 26, legendY + 2);

    // Y-axis grid lines
    const steps = 5;
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';

    for (let i = 0; i <= steps; i++) {
      const y = padding.top + chartH - (i / steps) * chartH;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
      ctx.fillText((maxVal * i / steps).toFixed(1), padding.left - 8, y + 3);
    }

    // Draw bars
    rows.forEach((r, i) => {
      const x = padding.left + i * groupWidth + gap / 2;
      const estH = (r.estQty / maxVal) * chartH;
      const measH = (r.measQty / maxVal) * chartH;

      // Estimate bar
      ctx.fillStyle = '#0ea5e9';
      ctx.fillRect(x, padding.top + chartH - estH, barWidth, estH);

      // Measurement bar
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(x + barWidth + 4, padding.top + chartH - measH, barWidth, measH);

      // X-axis labels
      ctx.fillStyle = '#475569';
      ctx.font = '9px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.save();
      ctx.translate(x + barWidth + 2, padding.top + chartH + 12);
      ctx.rotate(-Math.PI / 4);
      ctx.fillText(r.itemNo, 0, 0);
      ctx.restore();
    });

    // Y-axis label
    ctx.save();
    ctx.translate(14, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#64748b';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Quantity', 0, 0);
    ctx.restore();

    // X-axis label
    ctx.fillStyle = '#64748b';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Item Number', w / 2, h - 10);
  },


  // ============================================
  // EXPORT TAB
  // ============================================
  renderExportTab(container) {
    const p = AppState.currentProject;

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
        <h2 style="margin:0; font-size:1.125rem; font-weight:700;">Export Reports</h2>
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:1rem;">
        <div class="card">
          <div class="card-body" style="text-align:center; padding:2rem;">
            <i class="fas fa-file-pdf" style="font-size:3rem; color:#ef4444; margin-bottom:1rem;"></i>
            <h3 style="margin:0 0 0.5rem;">Cost Estimate (PDF)</h3>
            <p style="color:#64748b; font-size:0.875rem; margin-bottom:1.5rem;">
              Export detailed estimate with letterhead, sub-rows, and photo appendix.
            </p>
            <button class="btn btn-danger" onclick="UI.exportPDF('estimate')">
              <i class="fas fa-download"></i> Download PDF
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-body" style="text-align:center; padding:2rem;">
            <i class="fas fa-file-pdf" style="font-size:3rem; color:#ef4444; margin-bottom:1rem;"></i>
            <h3 style="margin:0 0 0.5rem;">Measurement Book (PDF)</h3>
            <p style="color:#64748b; font-size:0.875rem; margin-bottom:1.5rem;">
              Export measurement records with field photos and geotags.
            </p>
            <button class="btn btn-danger" onclick="UI.exportPDF('measurement')">
              <i class="fas fa-download"></i> Download PDF
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-body" style="text-align:center; padding:2rem;">
            <i class="fas fa-file-pdf" style="font-size:3rem; color:#ef4444; margin-bottom:1rem;"></i>
            <h3 style="margin:0 0 0.5rem;">Progress Report (PDF)</h3>
            <p style="color:#64748b; font-size:0.875rem; margin-bottom:1.5rem;">
              Export progress comparison with estimate vs measurement analysis.
            </p>
            <button class="btn btn-danger" onclick="UI.exportPDF('progress')">
              <i class="fas fa-download"></i> Download PDF
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-body" style="text-align:center; padding:2rem;">
            <i class="fas fa-file-excel" style="font-size:3rem; color:#22c55e; margin-bottom:1rem;"></i>
            <h3 style="margin:0 0 0.5rem;">Estimate (Excel)</h3>
            <p style="color:#64748b; font-size:0.875rem; margin-bottom:1.5rem;">
              Multi-sheet workbook with summary, breakdown, and totals.
            </p>
            <button class="btn btn-success" onclick="UI.exportExcel('estimate')">
              <i class="fas fa-download"></i> Download Excel
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-body" style="text-align:center; padding:2rem;">
            <i class="fas fa-file-excel" style="font-size:3rem; color:#22c55e; margin-bottom:1rem;"></i>
            <h3 style="margin:0 0 0.5rem;">Measurement (Excel)</h3>
            <p style="color:#64748b; font-size:0.875rem; margin-bottom:1.5rem;">
              Export measurement data in structured Excel format.
            </p>
            <button class="btn btn-success" onclick="UI.exportExcel('measurement')">
              <i class="fas fa-download"></i> Download Excel
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-body" style="text-align:center; padding:2rem;">
            <i class="fas fa-file-excel" style="font-size:3rem; color:#22c55e; margin-bottom:1rem;"></i>
            <h3 style="margin:0 0 0.5rem;">Progress (Excel)</h3>
            <p style="color:#64748b; font-size:0.875rem; margin-bottom:1.5rem;">
              Export progress analysis with comparison data and summary.
            </p>
            <button class="btn btn-success" onclick="UI.exportExcel('progress')">
              <i class="fas fa-download"></i> Download Excel
            </button>
          </div>
        </div>
      </div>
    `;
  },

  async exportPDF(type) {
    const project = AppState.currentProject;
    let items;
    if (type === 'estimate') items = AppState.estimates;
    else if (type === 'measurement') items = AppState.measurements;
    else items = AppState.estimates;

    showToast('Generating PDF...', 'info');
    try {
      await ExportEngine.generatePDF(project, items, type, AppState.measurements);
    } catch (err) {
      console.error(err);
      showToast('PDF generation failed: ' + err.message, 'error');
    }
  },

  async exportExcel(type) {
    const project = AppState.currentProject;
    let items;
    if (type === 'estimate') items = AppState.estimates;
    else if (type === 'measurement') items = AppState.measurements;
    else items = AppState.estimates;

    showToast('Generating Excel...', 'info');
    try {
      await ExportEngine.generateExcel(project, items, type, AppState.measurements);
    } catch (err) {
      console.error(err);
      showToast('Excel generation failed: ' + err.message, 'error');
    }
  },

  // ============================================
  // PHOTO HANDLING
  // ============================================
  async addPhotoToSubRow(input, itemId, subRowId, type) {
    const file = input.files[0];
    if (!file) return;

    showToast('Compressing photo...', 'info');
    const photo = await PhotoEngine.savePhoto(file, AppState.projectId, itemId, subRowId, type);
    if (photo) {
      showToast('Photo added successfully', 'success');
      if (type === 'estimate') {
        this.renderEstimateTab(document.getElementById('tab-content'));
      } else {
        this.renderMeasurementTab(document.getElementById('tab-content'));
      }
    }
    input.value = '';
  },

  async deletePhoto(photoId) {
    if (!confirm('Delete this photo?')) return;
    await PhotoEngine.deletePhoto(photoId);
    showToast('Photo deleted', 'success');
    const tabContent = document.getElementById('tab-content');
    if (AppState.tab === 'estimate') this.renderEstimateTab(tabContent);
    else if (AppState.tab === 'measurement') this.renderMeasurementTab(tabContent);
  },

  openLightbox(photoId) {
    const photo = AppState.photos.find(p => p.id === photoId);
    if (!photo) return;

    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay active';
    overlay.innerHTML = `
      <button class="lightbox-close" onclick="this.parentElement.remove()">×</button>
      <img src="${photo.data}" alt="${Utils.escapeHtml(photo.caption || 'Photo')}">
      ${photo.geotag ? `
        <div style="position:absolute; bottom:2rem; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.7); color:white; padding:0.5rem 1rem; border-radius:0.5rem; font-size:0.875rem;">
          <i class="fas fa-map-marker-alt"></i> ${photo.geotag.lat.toFixed(6)}, ${photo.geotag.lng.toFixed(6)}
        </div>
      ` : ''}
    `;
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  },

  // ============================================
  // PROJECT CRUD
  // ============================================
  async openProjectModal(editId = null) {
    const editProject = editId ? await db.projects.get(editId) : null;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.id = 'project-modal';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${editProject ? 'Edit' : 'New'} Project</h3>
          <button class="modal-close" onclick="document.getElementById('project-modal').remove()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Project Name *</label>
            <input type="text" class="form-input" id="proj-name" value="${editProject ? Utils.escapeHtml(editProject.name) : ''}" placeholder="Enter project name">
          </div>
          <div class="form-group">
            <label class="form-label">Location</label>
            <input type="text" class="form-input" id="proj-location" value="${editProject ? Utils.escapeHtml(editProject.location || '') : ''}" placeholder="Project location">
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
            <div class="form-group">
              <label class="form-label">Budget Head Number</label>
              <input type="text" class="form-input" id="proj-budget" value="${editProject ? Utils.escapeHtml(editProject.budgetHead || '') : ''}">
            </div>
            <div class="form-group">
              <label class="form-label">Total Allocation (Rs.)</label>
              <input type="number" class="form-input" id="proj-allocation" value="${editProject ? editProject.totalAllocation || '' : ''}" step="0.01">
            </div>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
            <div class="form-group">
              <label class="form-label">Date of Commencement</label>
              <input type="date" class="form-input" id="proj-date" value="${editProject ? editProject.dateOfCommencement || '' : ''}">
            </div>
            <div class="form-group">
              <label class="form-label">Project ID</label>
              <input type="text" class="form-input" id="proj-id" value="${editProject ? Utils.escapeHtml(editProject.projectId || '') : ''}">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Contractor Details</label>
            <input type="text" class="form-input" id="proj-contractor" value="${editProject ? Utils.escapeHtml(editProject.contractorDetails || '') : ''}">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('project-modal').remove()">Cancel</button>
          <button class="btn btn-primary" onclick="UI.saveProject('${editId || ''}')">
            ${editProject ? 'Update' : 'Create'} Project
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  },

  async saveProject(editId) {
    const name = document.getElementById('proj-name').value.trim();
    if (!name) {
      showToast('Project name is required', 'error');
      return;
    }

    const projectData = {
      name,
      location: document.getElementById('proj-location').value.trim(),
      budgetHead: document.getElementById('proj-budget').value.trim(),
      totalAllocation: parseFloat(document.getElementById('proj-allocation').value) || 0,
      dateOfCommencement: document.getElementById('proj-date').value,
      projectId: document.getElementById('proj-id').value.trim(),
      contractorDetails: document.getElementById('proj-contractor').value.trim(),
      letterhead: { departmentName: '', officeAddress: '', contactInfo: '', documentSubtitle: '', logo: '' },
      updatedAt: Date.now()
    };

    try {
      if (editId) {
        const existing = await db.projects.get(editId);
        projectData.id = editId;
        projectData.createdAt = existing.createdAt;
        projectData.letterhead = existing.letterhead || projectData.letterhead;
        await db.projects.put(projectData);
        showToast('Project updated successfully', 'success');
      } else {
        projectData.id = Utils.generateId();
        projectData.createdAt = Date.now();
        await db.projects.add(projectData);
        showToast('Project created successfully', 'success');
      }

      document.getElementById('project-modal').remove();
      await AppState.loadProjects();
      this.renderDashboard();
    } catch (err) {
      console.error(err);
      showToast('Failed to save project: ' + err.message, 'error');
    }
  },

  async editProject(projectId) {
    this.openProjectModal(projectId);
  },

  async deleteProject(projectId) {
    if (!confirm('Delete this project and ALL its data? This cannot be undone.')) return;

    try {
      await db.projects.delete(projectId);
      await db.estimateItems.where('projectId').equals(projectId).delete();
      await db.measurementItems.where('projectId').equals(projectId).delete();
      await db.photos.where('projectId').equals(projectId).delete();
      await db.letterheads.where('projectId').equals(projectId).delete();

      showToast('Project deleted', 'success');
      await AppState.loadProjects();
      this.renderDashboard();
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  },

  // ============================================
  // IMPORT FROM CSV/EXCEL
  // ============================================
  async handleImport(input) {
    const file = input.files[0];
    if (!file) return;

    showToast('Processing import...', 'info');

    try {
      if (file.name.endsWith('.csv')) {
        await this.importCSV(file);
      } else {
        await this.importExcel(file);
      }
      input.value = '';
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
      input.value = '';
    }
  },

  async importCSV(file) {
    const text = await file.text();
    const lines = text.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

    const projectId = Utils.generateId();
    const projectName = file.name.replace(/\.csv$/i, '');

    await db.projects.add({
      id: projectId,
      name: projectName,
      location: '',
      budgetHead: '',
      totalAllocation: 0,
      dateOfCommencement: '',
      contractorDetails: '',
      projectId: '',
      letterhead: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const itemsMap = new Map();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const itemNo = cols[0];
      const description = cols[1];
      const unit = cols[2];
      const rate = parseFloat(cols[3]) || 0;

      if (!itemNo || !description) continue;

      let item = itemsMap.get(itemNo);
      if (!item) {
        item = {
          id: Utils.generateId(),
          projectId,
          itemNo,
          description,
          unit,
          sanctionedRate: rate,
          subRows: [],
          totalQuantity: 0,
          totalAmount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        itemsMap.set(itemNo, item);
      }

      const nos = parseFloat(cols[4]) || 0;
      const len = parseFloat(cols[5]) || 0;
      const brd = parseFloat(cols[6]) || 0;
      const hgt = parseFloat(cols[7]) || 0;

      let qty = nos;
      if (unit === 'm³') qty = nos * len * brd * hgt;
      else if (unit === 'm²') qty = nos * len * brd;
      else if (unit === 'm') qty = nos * len;

      item.subRows.push({
        id: Utils.generateId(),
        projectId,
        estimateItemId: item.id,
        subDescription: cols[8] || `Row ${item.subRows.length + 1}`,
        nos: String(nos),
        nosEvaluated: nos,
        length: String(len),
        lengthEvaluated: len,
        breadth: String(brd),
        breadthEvaluated: brd,
        height: String(hgt),
        heightEvaluated: hgt,
        quantity: qty,
        amount: qty * rate,
        photos: [],
        createdAt: Date.now()
      });
    }

    for (const item of itemsMap.values()) {
      item.totalQuantity = item.subRows.reduce((s, r) => s + r.quantity, 0);
      item.totalAmount = item.subRows.reduce((s, r) => s + r.amount, 0);
      await db.estimateItems.add(item);
      await this.createMeasurementItem(item);
    }

    showToast(`Imported ${itemsMap.size} items from CSV`, 'success');
    await AppState.loadProjects();
    this.renderDashboard();
  },

  async importExcel(file) {
    const data = await file.arrayBuffer();
    const XLSX = window.XLSX;
    const wb = XLSX.read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

    if (rows.length < 2) {
      showToast('No data found in Excel file', 'error');
      return;
    }

    const projectId = Utils.generateId();
    const projectName = file.name.replace(/\.(xlsx|xls)$/i, '');

    await db.projects.add({
      id: projectId,
      name: projectName,
      location: '',
      budgetHead: '',
      totalAllocation: 0,
      dateOfCommencement: '',
      contractorDetails: '',
      projectId: '',
      letterhead: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const itemsMap = new Map();

    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i];
      const itemNo = String(cols[0] || '');
      const description = String(cols[1] || '');
      const unit = String(cols[2] || '');
      const rate = parseFloat(cols[3]) || 0;

      if (!itemNo || !description) continue;

      let item = itemsMap.get(itemNo);
      if (!item) {
        item = {
          id: Utils.generateId(),
          projectId,
          itemNo,
          description,
          unit,
          sanctionedRate: rate,
          subRows: [],
          totalQuantity: 0,
          totalAmount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        itemsMap.set(itemNo, item);
      }

      const nos = parseFloat(cols[4]) || 0;
      const len = parseFloat(cols[5]) || 0;
      const brd = parseFloat(cols[6]) || 0;
      const hgt = parseFloat(cols[7]) || 0;

      let qty = nos;
      if (unit === 'm³') qty = nos * len * brd * hgt;
      else if (unit === 'm²') qty = nos * len * brd;
      else if (unit === 'm') qty = nos * len;

      item.subRows.push({
        id: Utils.generateId(),
        projectId,
        estimateItemId: item.id,
        subDescription: String(cols[8] || `Row ${item.subRows.length + 1}`),
        nos: String(nos),
        nosEvaluated: nos,
        length: String(len),
        lengthEvaluated: len,
        breadth: String(brd),
        breadthEvaluated: brd,
        height: String(hgt),
        heightEvaluated: hgt,
        quantity: qty,
        amount: qty * rate,
        photos: [],
        createdAt: Date.now()
      });
    }

    for (const item of itemsMap.values()) {
      item.totalQuantity = item.subRows.reduce((s, r) => s + r.quantity, 0);
      item.totalAmount = item.subRows.reduce((s, r) => s + r.amount, 0);
      await db.estimateItems.add(item);
      await this.createMeasurementItem(item);
    }

    showToast(`Imported ${itemsMap.size} items from Excel`, 'success');
    await AppState.loadProjects();
    this.renderDashboard();
  },

  // ============================================
  // NAVIGATION
  // ============================================
  goDashboard() {
    AppState.view = 'dashboard';
    AppState.projectId = null;
    AppState.tab = 'setup';
    AppState.expandedItems.clear();
    this.render();
  },

  async openProject(projectId) {
    AppState.view = 'project';
    AppState.projectId = projectId;
    AppState.tab = 'setup';
    AppState.expandedItems.clear();
    await AppState.loadProjectData(projectId);
    this.render();
  },

  switchTab(tab) {
    AppState.tab = tab;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    event.target.closest('.nav-tab').classList.add('active');
    this.renderTab();
  },

  async saveProjectData() {
    showToast('All data saved to IndexedDB', 'success');
  }
};

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('SW registered'))
      .catch(err => console.log('SW registration failed:', err));
  }

  UI.init();
});
