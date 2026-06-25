// Chứa hàm điều hướng (render) ra trang Upload ban đầu.
exports.getUploadPage = (req, res) => {
    res.render('upload', {
        pageTitle: 'Tải lên & Tóm tắt',
    });
};
