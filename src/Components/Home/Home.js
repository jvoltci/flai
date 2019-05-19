import React, { Component } from 'react';
import './Home.css';


const List = ({ items }) => (
  <ul className="ulist">
    <ul className="vlist">
      {
        items.map((item, i) => <li key={i} className="litem"><a className="link" href={"https://flai-api.herokuapp.com/torrent/"+ item}>{item}</a></li>)
      }
    </ul>
  </ul>
  );

class App extends Component {

  constructor() {
    super();
    this.state = {
      extension: '',
      list: 0,
      files: [],
      url: '',
      password: ''
    }
  }

  changeExtension = (event) => {
    this.setState({extension: event.target.value});     
  }

  changeURL = (event) => {
    this.setState({url: event.target.value});     
  }

  changePassword = (event) => {
    this.setState({password: event.target.value});     
  }


  handleTorrent = () => {
    fetch('https://flai-api.herokuapp.com/metadata', {
          method: "POST",
          body: JSON.stringify({url: this.state.url, password: this.state.password}),
          headers: {
            "Content-Type": "application/json"
          }})
        .then(res => res.json())
        .then(res => {
          this.setState({files: res, list: 1, extension: ''})
        })
        .catch(error => console.error('Error:', error));
  }

  componentDidUpdate() {
    if(this.state.extension === "magnet") {
      this.handleTorrent();
    }
  }

  render() {
    return (
      <div id="home" className="container">
        <h3 id="u1">Welcome To fl<span id="u11">ai</span> Downloads</h3>
        <div className="row">
          <div className="col-12" align="center">
            <form onSubmit={e => this.state.extension==="magnet"?e.preventDefault():''} method="post" action="https://flai-api.herokuapp.com/download" >
              <div className="form-group">
                <input onChange={(e) => this.changeURL(e)}
                 type="text" name="user[url]" required className="form-control" placeholder="Downloadable URL | Magnet URI" id="u2" />
                <input onChange={(e) => this.changePassword(e)}
                 type="password" name="user[password]" required className="form-control" placeholder="Password" id="u3" />
                <input 
                  onChange={(e) => this.changeExtension(e)} 
                  list="extension" name="user[extension]" required className="extension" placeholder="Extension" id="u4" />
                <datalist id="extension" >
                  <option value=".zip">.zip</option>
                  <option value=".mp4">.mp4</option>
                  <option value=".exe">.exe</option>
                  <option value="magnet">magnet</option>
                </datalist>
                <button type="submit" className="btn btn-danger">Download</button>
              </div>
            </form>

            { this.state.list? <List items={this.state.files} />: '' }

          </div>
        </div>
      </div>
    );
  }
}

export default App;